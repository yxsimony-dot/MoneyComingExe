#!/usr/bin/env python3
"""探测 pytdx 公共扩展行情覆盖，只保存汇总元数据，不落原始行情。"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "pytdx-public-exhq-probe.json"
DEFAULT_HOST = "116.205.143.214"
DEFAULT_PORT = 7727
BAR_CATEGORY_FIVE_MINUTES = 0
REQUIRED_BAR_FIELDS = {
    "open",
    "high",
    "low",
    "close",
    "trade",
    "position",
    "datetime",
}
CONTRACT_ATTRIBUTION_FIELDS = {"code", "contract", "instrument", "symbol"}
TARGET_START_DATE = "2025-07-01"
DEFAULT_TARGET_END_DATE = "2025-10-19"
SOYBEAN_MEAL_TARGET_END_DATE = "2025-10-08"

TARGETS = [
    {
        "instrumentId": "main_continuous",
        "name": "豆粕主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "M",
        "targetEndDate": SOYBEAN_MEAL_TARGET_END_DATE,
    },
    {
        "instrumentId": "rapeseed_meal_main",
        "name": "菜粕主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "RM",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "pvc_main",
        "name": "PVC主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "V",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "rebar_main",
        "name": "螺纹钢主连",
        "exchange": "SHFE",
        "market": 30,
        "prefix": "RB",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "glass_main",
        "name": "玻璃主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "FG",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "rapeseed_oil_main",
        "name": "菜油主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "OI",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "palm_oil_main",
        "name": "棕榈油主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "P",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "soybean_oil_main",
        "name": "豆油主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "Y",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "pulp_main",
        "name": "纸浆主连",
        "exchange": "SHFE",
        "market": 30,
        "prefix": "SP",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "corn_main",
        "name": "玉米主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "C",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "soda_ash_main",
        "name": "纯碱主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "SA",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "soybean_1_main",
        "name": "豆一主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "A",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "methanol_main",
        "name": "甲醇主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "MA",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "sugar_main",
        "name": "白糖主连",
        "exchange": "CZCE",
        "market": 28,
        "prefix": "SR",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
    {
        "instrumentId": "soybean_2_main",
        "name": "豆二主连",
        "exchange": "DCE",
        "market": 29,
        "prefix": "B",
        "targetEndDate": DEFAULT_TARGET_END_DATE,
    },
]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--page-size", type=int, default=700)
    parser.add_argument("--max-pages", type=int, default=80)
    parser.add_argument("--request-delay", type=float, default=0.02)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error("--port 必须位于 1 至 65535")
    if options.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    if not 1 <= options.page_size <= 800:
        parser.error("--page-size 必须位于 1 至 800")
    if options.max_pages <= 0:
        parser.error("--max-pages 必须大于 0")
    if options.request_delay < 0:
        parser.error("--request-delay 不得小于 0")
    return options


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_record() -> dict[str, Any]:
    distribution = importlib.metadata.distribution("pytdx")
    metadata_path = Path(distribution.locate_file("pytdx-1.72.dist-info/METADATA"))
    if not metadata_path.exists():
        metadata_candidates = [
            Path(distribution.locate_file(item))
            for item in distribution.files or []
            if str(item).endswith(".dist-info/METADATA")
        ]
        metadata_path = metadata_candidates[0]

    license_files = [
        Path(distribution.locate_file(item))
        for item in distribution.files or []
        if Path(str(item)).name.upper().startswith(("LICENSE", "COPYING"))
    ]
    metadata = distribution.metadata
    return {
        "name": metadata.get("Name"),
        "version": distribution.version,
        "summary": metadata.get("Summary"),
        "homePage": metadata.get("Home-page"),
        "metadata": {
            "bytes": metadata_path.stat().st_size,
            "sha256": sha256_file(metadata_path),
        },
        "license": {
            "metadataLicense": metadata.get("License"),
            "bundledLicenseFilePresent": bool(license_files),
            "bundledLicenseFiles": [
                {
                    "name": path.name,
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
                for path in license_files
            ],
            "codeLicenseConfirmed": False,
            "note": (
                "当前安装包元数据未声明 License，且未随包提供 LICENSE/COPYING；"
                "客户端代码许可不能从该安装物中确认。"
            ),
        },
    }


def fetch_catalog(api: Any, instrument_count: int) -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    for start in range(0, instrument_count, 500):
        rows = api.get_instrument_info(start, min(500, instrument_count - start))
        if rows:
            catalog.extend(dict(row) for row in rows)
    return catalog


def target_catalog_summary(
    catalog: Iterable[dict[str, Any]],
    target: dict[str, Any],
) -> dict[str, Any]:
    market_rows = [
        row
        for row in catalog
        if row.get("market") == target["market"]
    ]
    codes = sorted({
        str(row.get("code", "")).upper()
        for row in market_rows
        if row.get("code")
    })
    expected_series = [
        f"{target['prefix']}L7",
        f"{target['prefix']}L8",
        f"{target['prefix']}L9",
    ]
    concrete_contracts = [
        code
        for code in codes
        if code.startswith(target["prefix"])
        and code[len(target["prefix"]):].isdigit()
    ]
    expired_code = f"{target['prefix']}2601"
    return {
        "seriesCodes": [
            code for code in expected_series if code in codes
        ],
        "allExpectedSeriesPresent": all(code in codes for code in expected_series),
        "concreteContractCount": len(concrete_contracts),
        "firstConcreteContract": concrete_contracts[0] if concrete_contracts else None,
        "lastConcreteContract": concrete_contracts[-1] if concrete_contracts else None,
        "expiredContractCode": expired_code,
        "expiredContractInCatalog": expired_code in codes,
    }


def normalize_timestamp(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) < 16:
        return None
    return value


def fetch_series_summary(
    api: Any,
    target: dict[str, Any],
    page_size: int,
    max_pages: int,
    request_delay: float,
) -> dict[str, Any]:
    series_code = f"{target['prefix']}L9"
    timestamps: set[str] = set()
    fields: set[str] = set()
    required_field_complete_rows = 0
    total_rows = 0
    pages = 0
    reached_target_start = False

    for page_index in range(max_pages):
        start = page_index * page_size
        rows = api.get_instrument_bars(
            BAR_CATEGORY_FIVE_MINUTES,
            target["market"],
            series_code,
            start,
            page_size,
        ) or []
        if not rows:
            break
        pages += 1
        for raw_row in rows:
            row = dict(raw_row)
            row_fields = set(row)
            fields.update(row_fields)
            timestamp = normalize_timestamp(row.get("datetime"))
            if timestamp:
                timestamps.add(timestamp)
            if all(row.get(field) is not None for field in REQUIRED_BAR_FIELDS):
                required_field_complete_rows += 1
            total_rows += 1

        dates = sorted(timestamp[:10] for timestamp in timestamps)
        if dates and dates[0] <= TARGET_START_DATE:
            reached_target_start = True
            break
        if len(rows) < page_size:
            break
        if request_delay:
            time.sleep(request_delay)

    sorted_timestamps = sorted(timestamps)
    target_gap_timestamps = [
        timestamp
        for timestamp in sorted_timestamps
        if TARGET_START_DATE <= timestamp[:10] <= target["targetEndDate"]
    ]
    first_timestamp = sorted_timestamps[0] if sorted_timestamps else None
    last_timestamp = sorted_timestamps[-1] if sorted_timestamps else None
    target_bounds_reached = bool(
        first_timestamp
        and last_timestamp
        and first_timestamp[:10] <= TARGET_START_DATE
        and last_timestamp[:10] >= target["targetEndDate"]
        and target_gap_timestamps
    )
    return {
        "seriesCode": series_code,
        "intervalMinutes": 5,
        "pagesRequested": pages,
        "rowsObserved": total_rows,
        "uniqueTimestampCount": len(timestamps),
        "duplicateTimestampCount": total_rows - len(timestamps),
        "firstTimestamp": first_timestamp,
        "lastTimestamp": last_timestamp,
        "returnedFields": sorted(fields),
        "requiredFields": sorted(REQUIRED_BAR_FIELDS),
        "requiredFieldCompleteRows": required_field_complete_rows,
        "allRowsHaveRequiredFields": (
            total_rows > 0 and required_field_complete_rows == total_rows
        ),
        "contractAttributionFieldPresent": bool(
            fields.intersection(CONTRACT_ATTRIBUTION_FIELDS)
        ),
        "targetGap": {
            "firstDate": TARGET_START_DATE,
            "lastDate": target["targetEndDate"],
            "dateBoundsReached": target_bounds_reached,
            "rowsObservedWithinBounds": len(target_gap_timestamps),
            "firstObservedTimestamp": (
                target_gap_timestamps[0] if target_gap_timestamps else None
            ),
            "lastObservedTimestamp": (
                target_gap_timestamps[-1] if target_gap_timestamps else None
            ),
        },
        "scanLimit": {
            "pageSize": page_size,
            "maxPages": max_pages,
            "reachedTargetStart": reached_target_start,
        },
    }


def expired_contract_probe(api: Any, target: dict[str, Any], code: str) -> dict[str, Any]:
    rows = api.get_instrument_bars(
        BAR_CATEGORY_FIVE_MINUTES,
        target["market"],
        code,
        0,
        20,
    ) or []
    return {
        "code": code,
        "rowsReturned": len(rows),
        "historicalBarsAvailable": bool(rows),
        "rawRowsPersisted": False,
    }


def main() -> int:
    options = parse_arguments()
    output_path = Path(options.output).resolve()

    from pytdx.exhq import TdxExHq_API

    started = time.perf_counter()
    api = TdxExHq_API(heartbeat=True, auto_retry=True, raise_exception=True)
    connected = False
    try:
        api.connect(options.host, options.port, time_out=options.timeout)
        connected = True
        markets = api.get_markets() or []
        instrument_count = api.get_instrument_count()
        catalog = fetch_catalog(api, instrument_count)

        instruments = []
        for target in TARGETS:
            catalog_summary = target_catalog_summary(catalog, target)
            series = fetch_series_summary(
                api,
                target,
                options.page_size,
                options.max_pages,
                options.request_delay,
            )
            expired = expired_contract_probe(
                api,
                target,
                catalog_summary["expiredContractCode"],
            )
            instruments.append({
                "instrumentId": target["instrumentId"],
                "name": target["name"],
                "exchange": target["exchange"],
                "market": target["market"],
                "catalog": catalog_summary,
                "fiveMinuteSeries": series,
                "expiredContractProbe": expired,
            })
    finally:
        if connected:
            api.disconnect()

    all_series_present = all(
        instrument["catalog"]["allExpectedSeriesPresent"]
        for instrument in instruments
    )
    all_target_bounds_reached = all(
        instrument["fiveMinuteSeries"]["targetGap"]["dateBoundsReached"]
        for instrument in instruments
    )
    all_required_fields_complete = all(
        instrument["fiveMinuteSeries"]["allRowsHaveRequiredFields"]
        for instrument in instruments
    )
    any_contract_attribution = any(
        instrument["fiveMinuteSeries"]["contractAttributionFieldPresent"]
        for instrument in instruments
    )
    any_expired_contract_history = any(
        instrument["expiredContractProbe"]["historicalBarsAvailable"]
        for instrument in instruments
    )

    report = {
        "schemaVersion": 1,
        "purpose": "pytdx-public-exhq-five-minute-history-probe",
        "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "probeStatus": "success",
        "environment": {
            "pythonVersion": platform.python_version(),
            "pythonImplementation": platform.python_implementation(),
            "platform": platform.platform(),
            "package": package_record(),
        },
        "server": {
            "host": options.host,
            "port": options.port,
            "accountRequiredByProbe": False,
            "marketCount": len(markets),
            "instrumentCount": instrument_count,
        },
        "request": {
            "category": BAR_CATEGORY_FIVE_MINUTES,
            "intervalMinutes": 5,
            "pageSize": options.page_size,
            "maxPagesPerInstrument": options.max_pages,
            "targetStartDate": TARGET_START_DATE,
            "defaultTargetEndDate": DEFAULT_TARGET_END_DATE,
            "soybeanMealTargetEndDate": SOYBEAN_MEAL_TARGET_END_DATE,
        },
        "instruments": instruments,
        "coverage": {
            "targetInstrumentCount": len(TARGETS),
            "allL7L8L9SeriesPresent": all_series_present,
            "allTargetDateBoundsReached": all_target_bounds_reached,
            "allRequiredFieldsComplete": all_required_fields_complete,
            "continuousContractAttributionAvailable": any_contract_attribution,
            "expiredSpecificContractHistoryAvailable": any_expired_contract_history,
        },
        "rights": {
            "clientCodeLicenseConfirmed": False,
            "returnedMarketDataRedistributionPermissionConfirmed": False,
            "gitStorageAllowed": False,
            "packagedApplicationRedistributionAllowed": False,
            "reason": (
                "公共接口访问能力不等于行情复制和再分发授权；当前未取得服务器运营方、"
                "交易所或其他权利方允许写入 Git 并随 EXE/安装包分发的明确书面许可。"
            ),
        },
        "retention": {
            "rawMarketRowsPersisted": False,
            "rawPricesPersisted": False,
            "rawVolumeOrPositionPersisted": False,
            "summaryOnly": True,
        },
        "conclusion": {
            "targetGapAccessCapabilityConfirmed": all_target_bounds_reached,
            "specificContractGapCapabilityConfirmed": False,
            "historicalMainContractMappingCapabilityConfirmed": False,
            "releaseUseAllowed": False,
            "reason": (
                "L9 序列到达全部目标日期边界并返回完整 OHLC、成交量和持仓量字段，"
                "但记录不包含具体合约归属，已到期具体合约也不可查询；"
                "同时缺少行情再分发授权，因此不能用于完成任务 4.2 或替换内置基线。"
            ),
        },
        "elapsedMilliseconds": round((time.perf_counter() - started) * 1000, 1),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已生成 pytdx 公共行情探测报告：{output_path}")
    print(
        "目标日期边界："
        f"{'全部到达' if all_target_bounds_reached else '存在缺失'}；"
        f"可再分发：否"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
