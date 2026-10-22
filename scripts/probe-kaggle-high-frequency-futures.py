#!/usr/bin/env python3
"""探测 Kaggle 中国期货分钟数据集，只保存汇总元数据，不落原始行情。"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import tempfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "kaggle-high-frequency-futures-data-china-probe.json"
DATASET_REF = "wentinglu/highfrequency-futures-data-china"
DATASET_VIEW_URL = f"https://www.kaggle.com/api/v1/datasets/view/{DATASET_REF}"
DATASET_FILES_URL = (
    f"https://www.kaggle.com/api/v1/datasets/list/{DATASET_REF}?pageSize=200"
)
DATASET_DOWNLOAD_URL = f"https://www.kaggle.com/api/v1/datasets/download/{DATASET_REF}"
SAMPLE_PREFIX = "M"
MAX_SAMPLE_DOWNLOAD_BYTES = 64 * 1024 * 1024
USER_AGENT = "MoneyComing Kaggle source audit/1"
TARGETS = [
    ("main_continuous", "豆粕主连", "M"),
    ("rapeseed_meal_main", "菜粕主连", "RM"),
    ("pvc_main", "PVC主连", "V"),
    ("rebar_main", "螺纹钢主连", "RB"),
    ("glass_main", "玻璃主连", "FG"),
    ("rapeseed_oil_main", "菜油主连", "OI"),
    ("palm_oil_main", "棕榈油主连", "P"),
    ("soybean_oil_main", "豆油主连", "Y"),
    ("pulp_main", "纸浆主连", "SP"),
    ("corn_main", "玉米主连", "C"),
    ("soda_ash_main", "纯碱主连", "SA"),
    ("soybean_1_main", "豆一主连", "A"),
    ("methanol_main", "甲醇主连", "MA"),
    ("sugar_main", "白糖主连", "SR"),
    ("soybean_2_main", "豆二主连", "B"),
]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--timeout", type=float, default=60.0)
    options = parser.parse_args()
    if options.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    return options


def request(url: str, timeout: float) -> urllib.response.addinfourl:
    return urllib.request.urlopen(
        urllib.request.Request(
            url,
            headers={
                "Accept": "application/json, application/zip, */*",
                "User-Agent": USER_AGENT,
            },
        ),
        timeout=timeout,
    )


def fetch_json(url: str, timeout: float) -> dict[str, Any]:
    with request(url, timeout) as response:
        return json.load(response)


def normalized_manifest_sha256(files: list[dict[str, Any]]) -> str:
    manifest = [
        {
            "name": item.get("name"),
            "totalBytes": item.get("totalBytes"),
            "creationDate": item.get("creationDate"),
        }
        for item in sorted(files, key=lambda item: item.get("name", ""))
    ]
    payload = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def download_sample(
    file_name: str,
    version_number: int,
    destination: Path,
    timeout: float,
) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "datasetVersionNumber": version_number,
            "filename": file_name,
        },
    )
    digest = hashlib.sha256()
    byte_count = 0
    with request(f"{DATASET_DOWNLOAD_URL}?{query}", timeout) as response:
        content_type = response.headers.get("Content-Type")
        content_length = response.headers.get("Content-Length")
        with destination.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                byte_count += len(chunk)
                if byte_count > MAX_SAMPLE_DOWNLOAD_BYTES:
                    raise RuntimeError(
                        f"样本下载超过 {MAX_SAMPLE_DOWNLOAD_BYTES} 字节上限",
                    )
                digest.update(chunk)
                output.write(chunk)
    return {
        "url": f"{DATASET_DOWNLOAD_URL}?{query}",
        "contentType": content_type,
        "declaredContentLength": int(content_length) if content_length else None,
        "downloadedBytes": byte_count,
        "sha256": digest.hexdigest(),
    }


def inspect_sample(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        if len(members) != 1:
            raise RuntimeError(f"样本 ZIP 应只有一个文件，实际为 {len(members)} 个")
        member = members[0]

        raw_digest = hashlib.sha256()
        with archive.open(member) as raw_stream:
            while chunk := raw_stream.read(1024 * 1024):
                raw_digest.update(chunk)

        with archive.open(member) as raw_stream:
            text_stream = io.TextIOWrapper(
                raw_stream,
                encoding="utf-8-sig",
                errors="strict",
                newline="",
            )
            reader = csv.DictReader(text_stream)
            columns = reader.fieldnames or []
            required_columns = {
                "Time",
                "Open",
                "High",
                "Low",
                "Close",
                "Volume",
                "Amount",
                "Open Interest",
            }
            if not required_columns.issubset(columns):
                raise RuntimeError(f"样本字段不符合预期：{columns}")

            row_count = 0
            first_timestamp = None
            last_timestamp = None
            minimum_timestamp = None
            maximum_timestamp = None
            previous_timestamp = None
            timestamps_sorted = True
            first_ohlc = None
            minimum_ohlc = None
            maximum_ohlc = None
            fractional_second_examples: set[str] = set()

            for row in reader:
                timestamp = row["Time"]
                ohlc = [
                    float(row["Open"]),
                    float(row["High"]),
                    float(row["Low"]),
                    float(row["Close"]),
                ]
                row_count += 1
                if first_timestamp is None:
                    first_timestamp = timestamp
                    first_ohlc = ohlc
                last_timestamp = timestamp
                minimum_timestamp = (
                    timestamp
                    if minimum_timestamp is None or timestamp < minimum_timestamp
                    else minimum_timestamp
                )
                maximum_timestamp = (
                    timestamp
                    if maximum_timestamp is None or timestamp > maximum_timestamp
                    else maximum_timestamp
                )
                if previous_timestamp is not None and timestamp < previous_timestamp:
                    timestamps_sorted = False
                previous_timestamp = timestamp
                row_minimum = min(ohlc)
                row_maximum = max(ohlc)
                minimum_ohlc = (
                    row_minimum
                    if minimum_ohlc is None or row_minimum < minimum_ohlc
                    else minimum_ohlc
                )
                maximum_ohlc = (
                    row_maximum
                    if maximum_ohlc is None or row_maximum > maximum_ohlc
                    else maximum_ohlc
                )
                if "." in timestamp and len(fractional_second_examples) < 20:
                    fractional_second_examples.add(timestamp.split(".", 1)[1])

    contract_column_present = any(
        "contract" in column.lower()
        or "instrument" in column.lower()
        or "symbol" in column.lower()
        for column in columns
    )
    normalized_price_scale_observed = bool(
        first_ohlc
        and all(value == 1.0 for value in first_ohlc)
        and minimum_ohlc is not None
        and maximum_ohlc is not None
        and 0 < minimum_ohlc < 10
        and 0 < maximum_ohlc < 10
    )
    return {
        "archiveMember": member.filename,
        "uncompressedBytes": member.file_size,
        "compressedBytes": member.compress_size,
        "rawCsvSha256": raw_digest.hexdigest(),
        "columns": columns,
        "rowCount": row_count,
        "firstTimestampInFile": first_timestamp,
        "lastTimestampInFile": last_timestamp,
        "minimumTimestamp": minimum_timestamp,
        "maximumTimestamp": maximum_timestamp,
        "timestampsSorted": timestamps_sorted,
        "fractionalSecondExamples": sorted(fractional_second_examples),
        "firstOhlc": first_ohlc,
        "minimumOhlc": minimum_ohlc,
        "maximumOhlc": maximum_ohlc,
        "normalizedPriceScaleObserved": normalized_price_scale_observed,
        "absolutePriceScaleAvailable": not normalized_price_scale_observed,
        "contractColumnPresent": contract_column_present,
    }


def main() -> None:
    options = parse_arguments()
    output = Path(options.output).resolve()
    metadata = fetch_json(DATASET_VIEW_URL, options.timeout)
    inventory = fetch_json(DATASET_FILES_URL, options.timeout)
    files = inventory.get("datasetFiles") or []
    next_page_token = inventory.get("nextPageToken")
    if next_page_token:
        raise RuntimeError("文件清单超过单页，探针尚未完整读取")

    files_by_name = {item["name"]: item for item in files}
    targets = [
        {
            "instrumentId": instrument_id,
            "name": name,
            "prefix": prefix,
            "file": f"minDataSum/{prefix}.csv",
            "present": f"minDataSum/{prefix}.csv" in files_by_name,
            "bytes": files_by_name.get(f"minDataSum/{prefix}.csv", {}).get(
                "totalBytes",
            ),
        }
        for instrument_id, name, prefix in TARGETS
    ]
    sample_name = f"minDataSum/{SAMPLE_PREFIX}.csv"
    if sample_name not in files_by_name:
        raise RuntimeError(f"数据集缺少样本文件：{sample_name}")

    version_number = int(metadata["currentVersionNumber"])
    with tempfile.TemporaryDirectory(prefix="moneycoming-kaggle-probe-") as temp_dir:
        sample_path = Path(temp_dir) / f"{SAMPLE_PREFIX}.csv.zip"
        download = download_sample(
            sample_name,
            version_number,
            sample_path,
            options.timeout,
        )
        sample = inspect_sample(sample_path)

    report = {
        "schemaVersion": 1,
        "purpose": "kaggle-high-frequency-futures-data-china-probe",
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {
            "datasetRef": DATASET_REF,
            "datasetId": metadata.get("id"),
            "title": metadata.get("title"),
            "subtitle": metadata.get("subtitle"),
            "description": metadata.get("description"),
            "lastUpdated": metadata.get("lastUpdated"),
            "currentVersionNumber": version_number,
            "declaredLicense": metadata.get("licenseName"),
            "datasetTotalBytes": metadata.get("totalBytes"),
            "fileCount": len(files),
            "normalizedManifestSha256": normalized_manifest_sha256(files),
            "viewEndpoint": DATASET_VIEW_URL,
            "filesEndpoint": DATASET_FILES_URL,
        },
        "target": {
            "instrumentCount": len(TARGETS),
            "allTargetFilesPresent": all(item["present"] for item in targets),
            "files": targets,
        },
        "sample": {
            "prefix": SAMPLE_PREFIX,
            "file": sample_name,
            "inventoryBytes": files_by_name[sample_name].get("totalBytes"),
            "download": download,
            **sample,
        },
        "rights": {
            "datasetLicenseClaimPresent": bool(metadata.get("licenseName")),
            "datasetLicenseIdentifier": metadata.get("licenseName"),
            "upstreamMarketDataProviderDocumented": False,
            "upstreamMarketDataAcquisitionDocumented": False,
            "upstreamRedistributionAuthorityDocumented": False,
        },
        "coverage": {
            "targetGapFirstDate": "2025-07-01",
            "targetGapCoverageConfirmed": False,
            "sampleLatestTimestamp": sample["maximumTimestamp"],
            "absolutePriceScaleAvailable": sample["absolutePriceScaleAvailable"],
            "concreteContractAttributionAvailable": sample["contractColumnPresent"],
            "historicalMainContractMappingCapabilityConfirmed": False,
        },
        "retention": {
            "sampleArchiveStoredOnlyInTemporaryDirectory": True,
            "temporarySampleDeletedAfterProbe": True,
            "rawCsvPersisted": False,
            "rawRowsPersisted": False,
            "summaryOnly": True,
        },
        "conclusion": {
            "technicalTargetGapCoverageConfirmed": False,
            "releaseEligibility": (
                "blocked-no-target-gap-no-absolute-prices-no-contract-attribution"
            ),
            "note": (
                "数据集当前版本停留在 2022 年；豆粕样本只到 2021-02-01，"
                "OHLC 为以 1.0 附近表示的归一化比例且没有基准价格字段，也没有具体合约代码。"
                "因此它既不能补齐 2025 年目标缺口，也不能恢复真实价格或生成可审计的主力换月映射。"
            ),
        },
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已生成 Kaggle 期货分钟数据探测摘要：{output}")


if __name__ == "__main__":
    main()
