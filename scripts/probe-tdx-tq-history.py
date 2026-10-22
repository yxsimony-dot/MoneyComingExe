#!/usr/bin/env python3
"""对通达信 TdxAiData 执行不落原始行情的最小历史探测。"""

from __future__ import annotations

import argparse
import configparser
import contextlib
import ctypes
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import re
import socket
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "tdx-tq-history-probe.json"
DEFAULT_FIELDS = ["Open", "High", "Low", "Close", "Volume", "VolInStock"]
SENSITIVE_INI_KEYS = {"token", "user", "username", "password", "secret", "key"}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="M2601.DCE")
    parser.add_argument("--start", default="2025-07-01 00:00:00")
    parser.add_argument("--end", default="2025-07-07 23:59:59")
    parser.add_argument("--period", default="5m")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--timeout", type=float, default=3.0)
    options = parser.parse_args()
    if options.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    for name in ("start", "end"):
        try:
            datetime.fromisoformat(getattr(options, name))
        except ValueError as error:
            parser.error(f"--{name} 必须是 ISO 日期时间：{error}")
    return options


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_record(path: Path, base: Path) -> dict[str, Any]:
    value = path.read_bytes()
    return {
        "path": path.relative_to(base).as_posix(),
        "bytes": len(value),
        "sha256": sha256_bytes(value),
    }


def locate_distribution_files(package_directory: Path, version: str) -> dict[str, Path]:
    site_packages = package_directory.parent
    candidates = sorted(site_packages.glob(f"tdxaidata-{version}.dist-info"))
    if not candidates:
        candidates = sorted(site_packages.glob("tdxaidata-*.dist-info"))
    if not candidates:
        raise RuntimeError("未找到 tdxaidata dist-info 目录")
    dist_info = candidates[-1]
    return {
        "sitePackages": site_packages,
        "metadata": dist_info / "METADATA",
        "license": dist_info / "licenses" / "LICENSE",
    }


def read_ini_safely(path: Path) -> tuple[configparser.ConfigParser, dict[str, Any]]:
    raw_text = path.read_text(encoding="utf-8")
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(raw_text)

    sensitive_presence: dict[str, bool] = {}
    sanitized_lines = []
    assignment = re.compile(r"^(\s*)([^=:#;\s]+)(\s*[=:]\s*)(.*)$")
    for line in raw_text.splitlines():
        match = assignment.match(line)
        if not match:
            sanitized_lines.append(line)
            continue
        key = match.group(2).strip().lower()
        if key not in SENSITIVE_INI_KEYS:
            sanitized_lines.append(line)
            continue
        configured = bool(match.group(4).strip())
        sensitive_presence[key] = configured
        replacement = "<configured>" if configured else "<empty>"
        sanitized_lines.append(
            f"{match.group(1)}{match.group(2)}{match.group(3)}{replacement}"
        )

    sanitized = ("\n".join(sanitized_lines) + "\n").encode("utf-8")
    return parser, {
        "path": path.name,
        "sensitiveValuePresence": sensitive_presence,
        "sanitizedSha256": sha256_bytes(sanitized),
        "rawSha256Recorded": False,
        "note": "仅对脱敏后的配置文本计算哈希；未记录任何凭据原值或原文件哈希。",
    }


def configured_value(
    parser: configparser.ConfigParser,
    section: str,
    key: str,
) -> bool:
    return bool(parser.get(section, key, fallback="").strip())


def configured_servers(parser: configparser.ConfigParser) -> list[dict[str, Any]]:
    servers = []
    for section in ("TcHqHost", "TcDsHost"):
        if not parser.has_section(section):
            continue
        entries = {}
        for key, value in parser.items(section):
            match = re.fullmatch(r"ipaddress(\d+)", key.lower())
            if match:
                entries.setdefault(match.group(1), {})["host"] = value.strip()
                continue
            match = re.fullmatch(r"port(\d+)", key.lower())
            if match:
                try:
                    entries.setdefault(match.group(1), {})["port"] = int(value)
                except ValueError:
                    entries.setdefault(match.group(1), {})["port"] = None
        for index, entry in sorted(entries.items()):
            if entry.get("host") and entry.get("port"):
                servers.append({
                    "section": section,
                    "index": int(index),
                    "host": entry["host"],
                    "port": entry["port"],
                })
    return servers


def probe_tcp(server: dict[str, Any], timeout: float) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        with socket.create_connection(
            (server["host"], server["port"]),
            timeout=timeout,
        ):
            pass
        return {
            **server,
            "reachable": True,
            "latencyMilliseconds": round((time.perf_counter() - started) * 1000, 1),
            "errorCategory": None,
        }
    except socket.gaierror:
        category = "dns-resolution-failed"
    except TimeoutError:
        category = "timeout"
    except ConnectionRefusedError:
        category = "connection-refused"
    except OSError:
        category = "network-os-error"
    return {
        **server,
        "reachable": False,
        "latencyMilliseconds": round((time.perf_counter() - started) * 1000, 1),
        "errorCategory": category,
    }


def probe_dynamic_library(path: Path) -> dict[str, Any]:
    try:
        if os.name == "nt":
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(path.parent))
            ctypes.WinDLL(str(path))
        else:
            ctypes.CDLL(str(path))
        return {"loaded": True, "errorCategory": None}
    except OSError:
        return {"loaded": False, "errorCategory": "native-library-load-error"}


def index_text(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat(sep=" ")
        except TypeError:
            return value.isoformat()
    return str(value)


def summarize_market_result(result: Any, symbol: str) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {
            "shape": type(result).__name__,
            "returnedFields": [],
            "fieldRowCounts": {},
            "rowCount": 0,
            "firstTimestamp": None,
            "lastTimestamp": None,
        }

    row_counts: dict[str, int] = {}
    timestamps: list[Any] = []
    for field, value in result.items():
        count = 0
        if hasattr(value, "columns") and hasattr(value, "index"):
            if symbol in value.columns:
                series = value[symbol].dropna()
                count = len(series.index)
                timestamps.extend(series.index.tolist())
        elif isinstance(value, dict):
            rows = value.get(symbol)
            if isinstance(rows, list):
                count = len(rows)
        row_counts[str(field)] = count

    unique_timestamps = sorted(set(timestamps))
    return {
        "shape": "field-map",
        "returnedFields": sorted(str(field) for field in result),
        "fieldRowCounts": row_counts,
        "rowCount": max(row_counts.values(), default=0),
        "firstTimestamp": index_text(unique_timestamps[0]) if unique_timestamps else None,
        "lastTimestamp": index_text(unique_timestamps[-1]) if unique_timestamps else None,
    }


def diagnostic_categories(text: str) -> list[str]:
    lowered = text.lower()
    categories = []
    if "need token" in lowered or "tokenkey" in lowered or "认证" in text:
        categories.append("credential-required")
    if "积分" in text or "point" in lowered:
        categories.append("points-or-entitlement-mentioned")
    if "限流" in text or "rate limit" in lowered:
        categories.append("rate-limit-mentioned")
    if "返回空数据" in text or "empty" in lowered:
        categories.append("empty-response")
    if "[错误]" in text or "error" in lowered:
        categories.append("api-error")
    return sorted(set(categories))


def classify_probe(
    token_configured: bool,
    summary: dict[str, Any],
    categories: list[str],
    exception_type: str | None,
) -> str:
    if not token_configured or "credential-required" in categories:
        return "credential-blocked"
    if exception_type:
        return "api-error"
    if summary["rowCount"] > 0:
        return "records-returned"
    if "points-or-entitlement-mentioned" in categories:
        return "entitlement-or-points-blocked"
    return "empty-response"


def main() -> int:
    options = parse_arguments()
    output_path = Path(options.output).resolve()

    import tdxaidata
    from tdxaidata import tqs

    version = importlib.metadata.version("tdxaidata")
    package_directory = Path(tdxaidata.__file__).resolve().parent
    distribution_files = locate_distribution_files(package_directory, version)
    site_packages = distribution_files["sitePackages"]
    module_path = package_directory / "tdxaidata.py"
    documentation_path = package_directory / "docs" / "tdxaidata使用文档.md"
    dll_name = "TdxAiData.dll" if os.name == "nt" else (
        "libTdxAiData.dylib" if sys.platform == "darwin" else "libTdxAiData.so"
    )
    dll_path = package_directory / "lib" / dll_name
    ini_path = package_directory / "lib" / "TdxAiData.ini"
    ini_parser, safe_ini_record = read_ini_safely(ini_path)
    token_configured = configured_value(ini_parser, "Token", "token")
    user_configured = configured_value(ini_parser, "Token", "user")

    tcp_results = [
        probe_tcp(server, options.timeout)
        for server in configured_servers(ini_parser)
    ]
    dll_result = probe_dynamic_library(dll_path)

    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    result: Any = {}
    exception_type = None
    started = time.perf_counter()
    try:
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(
            captured_stderr
        ):
            result = tqs.get_market_data(
                field_list=DEFAULT_FIELDS,
                stock_list=[options.symbol],
                period=options.period,
                start_time=options.start,
                end_time=options.end,
                count=-1,
                dividend_type="none",
                fill_data=False,
            )
    except Exception as error:  # noqa: BLE001 - probe must classify native/API failures
        exception_type = type(error).__name__
    elapsed_milliseconds = round((time.perf_counter() - started) * 1000, 1)
    summary = summarize_market_result(result, options.symbol)
    categories = diagnostic_categories(
        f"{captured_stdout.getvalue()}\n{captured_stderr.getvalue()}"
    )
    status = classify_probe(token_configured, summary, categories, exception_type)

    report = {
        "schemaVersion": 1,
        "purpose": "tdx-tq-single-instrument-five-minute-history-probe",
        "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "probeStatus": status,
        "request": {
            "symbol": options.symbol,
            "period": options.period,
            "startTime": options.start,
            "endTime": options.end,
            "count": -1,
            "dividendType": "none",
            "fillData": False,
            "fields": DEFAULT_FIELDS,
        },
        "environment": {
            "pythonVersion": platform.python_version(),
            "pythonImplementation": platform.python_implementation(),
            "platform": platform.platform(),
            "tdxaidataVersion": version,
            "tdxaidataInstallScope": "external-python-environment",
        },
        "packageArtifacts": {
            "module": file_record(module_path, site_packages),
            "dynamicLibrary": file_record(dll_path, site_packages),
            "documentation": file_record(documentation_path, site_packages),
            "metadata": file_record(distribution_files["metadata"], site_packages),
            "license": file_record(distribution_files["license"], site_packages),
            "configuration": safe_ini_record,
        },
        "credentials": {
            "tokenConfigured": token_configured,
            "userConfigured": user_configured,
            "valuesRecorded": False,
            "valuesHashed": False,
        },
        "connectivity": {
            "allConfiguredServersReachable": bool(tcp_results)
            and all(result["reachable"] for result in tcp_results),
            "servers": tcp_results,
        },
        "dynamicLibrary": dll_result,
        "apiCall": {
            "elapsedMilliseconds": elapsed_milliseconds,
            "pythonException": exception_type is not None,
            "exceptionType": exception_type,
            "diagnosticCategories": categories,
            "rawDiagnosticsRecorded": False,
            "resultSummary": summary,
        },
        "requirements": {
            "client": f"tdxaidata {version} 文档声明不依赖通达信客户端。",
            "account": (
                "后台数据服务需要 TdxAiData.ini 的数据服务 Key；当前已配置但未记录其值。"
                if token_configured
                else "后台数据服务需要 TdxAiData.ini 的数据服务 Key；当前未配置。"
            ),
            "points": (
                "官方 get_market_data 文档提示较长时间段分钟数据可能消耗较多积分；"
                "本次无凭据探测无法读取余额或确认当前短区间的实际积分消耗。"
            ),
            "fields": {
                "requested": DEFAULT_FIELDS,
                "futureAmount": "官方包文档说明期货 Amount 为 0，本探测未请求 Amount。",
                "openInterest": "VolInStock 表示持仓量。",
            },
            "rateLimit": "当前官方包文档未公开每秒请求上限；不得据此猜测限流数字。",
        },
        "conclusion": {
            "shortRangeRecordsConfirmed": status == "records-returned",
            "fullGapConfirmed": False,
            "releaseUseAllowed": False,
            "reason": (
                "网络和动态库已到达认证阶段，但缺少数据服务 Key，"
                "尚不能确认目标短区间是否返回真实记录；本报告不包含原始行情。"
                if status == "credential-blocked"
                else "本次结论仅覆盖所列短区间；再分发资格必须由独立授权审计决定。"
            ),
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已生成通达信 TQ 历史探测报告：{output_path}")
    print(f"探测状态：{status}；返回记录数：{summary['rowCount']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
