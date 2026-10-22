#!/usr/bin/env python3
"""Probe a Hugging Face Chinese futures tick dataset without retaining raw rows."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow
import pyarrow.compute as pc
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "data" / "huggingface-domestic-futures-ticks-probe.json"
DATASET_ID = "EdisonFU2025/Domestic_Futures_ticks"
PINNED_COMMIT = "12c4bb2a0a34ba449b5d9d1c7b72b3d88a7c64c5"
SAMPLE_FILE = "M9999_XDCE_2025-08-24-17-45-05.parquet"
MAX_SAMPLE_BYTES = 96 * 1024 * 1024
USER_AGENT = "MoneyComing Hugging Face source audit/1"
DATASET_API = f"https://huggingface.co/api/datasets/{DATASET_ID}"
TREE_API = (
    f"https://huggingface.co/api/datasets/{DATASET_ID}/tree/{PINNED_COMMIT}"
    "?recursive=true&expand=true&limit=100"
)
README_URL = (
    f"https://huggingface.co/datasets/{DATASET_ID}/resolve/"
    f"{PINNED_COMMIT}/README.md?download=true"
)
SAMPLE_URL = (
    f"https://huggingface.co/datasets/{DATASET_ID}/resolve/{PINNED_COMMIT}/"
    f"{urllib.parse.quote(SAMPLE_FILE)}?download=true"
)
TARGETS = [
    ("main_continuous", "M", "XDCE"),
    ("rapeseed_meal_main", "RM", "XZCE"),
    ("pvc_main", "V", "XDCE"),
    ("rebar_main", "RB", "XSGE"),
    ("glass_main", "FG", "XZCE"),
    ("rapeseed_oil_main", "OI", "XZCE"),
    ("palm_oil_main", "P", "XDCE"),
    ("soybean_oil_main", "Y", "XDCE"),
    ("pulp_main", "SP", "XSGE"),
    ("corn_main", "C", "XDCE"),
    ("soda_ash_main", "SA", "XZCE"),
    ("soybean_1_main", "A", "XDCE"),
    ("methanol_main", "MA", "XZCE"),
    ("sugar_main", "SR", "XZCE"),
    ("soybean_2_main", "B", "XDCE"),
]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--timeout", type=float, default=120.0)
    options = parser.parse_args()
    if options.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    return options


def request(url: str, timeout: float) -> urllib.response.addinfourl:
    return urllib.request.urlopen(
        urllib.request.Request(
            url,
            headers={
                "Accept": "application/json, text/plain, application/octet-stream, */*",
                "User-Agent": USER_AGENT,
            },
        ),
        timeout=timeout,
    )


def fetch_json(url: str, timeout: float) -> Any:
    with request(url, timeout) as response:
        return json.load(response)


def fetch_text(url: str, timeout: float) -> str:
    with request(url, timeout) as response:
        return response.read().decode("utf-8")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized_manifest_sha256(entries: list[dict[str, Any]]) -> str:
    manifest = [
        {
            "path": entry.get("path"),
            "size": entry.get("size"),
            "lfsSha256": entry.get("lfs", {}).get("oid"),
            "lastCommit": entry.get("lastCommit", {}).get("id"),
        }
        for entry in sorted(entries, key=lambda item: item.get("path", ""))
        if entry.get("type") == "file"
    ]
    payload = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def download_sample(destination: Path, timeout: float) -> dict[str, Any]:
    digest = hashlib.sha256()
    byte_count = 0
    with request(SAMPLE_URL, timeout) as response:
        content_type = response.headers.get("Content-Type")
        content_length = response.headers.get("Content-Length")
        with destination.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                byte_count += len(chunk)
                if byte_count > MAX_SAMPLE_BYTES:
                    raise RuntimeError(
                        f"sample exceeds the {MAX_SAMPLE_BYTES}-byte probe limit",
                    )
                digest.update(chunk)
                output.write(chunk)
    return {
        "url": SAMPLE_URL,
        "contentType": content_type,
        "declaredContentLength": int(content_length) if content_length else None,
        "downloadedBytes": byte_count,
        "sha256": digest.hexdigest(),
    }


def json_scalar(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return value


def update_bounds(
    current_minimum: Any,
    current_maximum: Any,
    values: pyarrow.Array,
) -> tuple[Any, Any]:
    if len(values) == 0 or values.null_count == len(values):
        return current_minimum, current_maximum
    bounds = pc.min_max(values)
    batch_minimum = bounds["min"].as_py()
    batch_maximum = bounds["max"].as_py()
    minimum = (
        batch_minimum
        if current_minimum is None or batch_minimum < current_minimum
        else current_minimum
    )
    maximum = (
        batch_maximum
        if current_maximum is None or batch_maximum > current_maximum
        else current_maximum
    )
    return minimum, maximum


def inspect_sample(path: Path) -> dict[str, Any]:
    parquet_file = pq.ParquetFile(path)
    schema = parquet_file.schema_arrow
    required_columns = {
        "time",
        "current",
        "high",
        "low",
        "volume",
        "money",
        "position",
        "future",
    }
    if not required_columns.issubset(schema.names):
        raise RuntimeError(f"sample columns do not match expectations: {schema.names}")

    minimum_timestamp = None
    maximum_timestamp = None
    first_timestamp = None
    last_timestamp = None
    future_values: set[str] = set()
    scanned_rows = 0
    time_null_count = 0
    future_null_count = 0

    for batch in parquet_file.iter_batches(
        batch_size=131_072,
        columns=["time", "future"],
    ):
        time_array = batch.column(batch.schema.get_field_index("time"))
        future_array = batch.column(batch.schema.get_field_index("future"))
        scanned_rows += batch.num_rows
        time_null_count += time_array.null_count
        future_null_count += future_array.null_count
        minimum_timestamp, maximum_timestamp = update_bounds(
            minimum_timestamp,
            maximum_timestamp,
            time_array,
        )
        if batch.num_rows:
            if first_timestamp is None:
                first_timestamp = time_array[0].as_py()
            last_timestamp = time_array[-1].as_py()
        future_values.update(
            str(value)
            for value in pc.unique(future_array).to_pylist()
            if value is not None
        )

    concrete_contract_values = sorted(
        value
        for value in future_values
        if re.fullmatch(r"[A-Za-z]{1,3}\d{3,4}\.[A-Za-z]+", value)
        and "9999" not in value
    )
    metadata = parquet_file.metadata
    return {
        "pyarrowVersion": pyarrow.__version__,
        "parquetCreatedBy": metadata.created_by,
        "rowGroupCount": metadata.num_row_groups,
        "rowCount": metadata.num_rows,
        "scannedRows": scanned_rows,
        "columns": [
            {
                "name": field.name,
                "type": str(field.type),
                "nullable": field.nullable,
            }
            for field in schema
        ],
        "firstTimestampInFile": json_scalar(first_timestamp),
        "lastTimestampInFile": json_scalar(last_timestamp),
        "minimumTimestamp": json_scalar(minimum_timestamp),
        "maximumTimestamp": json_scalar(maximum_timestamp),
        "timeNullCount": time_null_count,
        "futureNullCount": future_null_count,
        "futureValues": sorted(future_values),
        "concreteContractValues": concrete_contract_values,
        "concreteContractAttributionAvailable": bool(concrete_contract_values),
    }


def timestamp_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()


def main() -> None:
    options = parse_arguments()
    output = Path(options.output).resolve()
    dataset = fetch_json(DATASET_API, options.timeout)
    tree = fetch_json(TREE_API, options.timeout)
    readme = fetch_text(README_URL, options.timeout)

    if dataset.get("sha") != PINNED_COMMIT:
        raise RuntimeError(
            f"dataset head changed from pinned commit: {dataset.get('sha')}",
        )
    if not isinstance(tree, list):
        raise RuntimeError("dataset tree response is not a list")
    entries_by_path = {entry["path"]: entry for entry in tree}
    sibling_paths = sorted(
        sibling["rfilename"]
        for sibling in dataset.get("siblings", [])
        if isinstance(sibling, dict) and sibling.get("rfilename")
    )
    tree_file_paths = sorted(
        entry["path"]
        for entry in tree
        if entry.get("type") == "file" and entry.get("path")
    )
    if tree_file_paths != sibling_paths:
        raise RuntimeError(
            "dataset tree inventory does not match the complete siblings inventory",
        )
    if SAMPLE_FILE not in entries_by_path:
        raise RuntimeError(f"sample file is missing: {SAMPLE_FILE}")

    target_files = []
    for instrument_id, symbol, exchange in TARGETS:
        pattern = re.compile(
            rf"^{re.escape(symbol)}9999_{re.escape(exchange)}_.+\.parquet$",
        )
        matches = sorted(
            path
            for path in sibling_paths
            if pattern.fullmatch(path)
        )
        target_files.append(
            {
                "instrumentId": instrument_id,
                "symbol": symbol,
                "exchange": exchange,
                "present": len(matches) == 1,
                "files": matches,
            },
        )

    sample_entry = entries_by_path[SAMPLE_FILE]
    with tempfile.TemporaryDirectory(prefix="moneycoming-huggingface-probe-") as temp_dir:
        sample_path = Path(temp_dir) / SAMPLE_FILE
        download = download_sample(sample_path, options.timeout)
        sample = inspect_sample(sample_path)

    lfs_sha256 = sample_entry.get("lfs", {}).get("oid")
    minimum_date = timestamp_date(sample["minimumTimestamp"])
    maximum_date = timestamp_date(sample["maximumTimestamp"])
    soybean_meal_gap_first = date(2025, 7, 1)
    soybean_meal_gap_last = date(2025, 10, 8)
    partial_gap_coverage = (
        minimum_date <= soybean_meal_gap_first <= maximum_date
    )
    complete_soybean_meal_gap_coverage = (
        minimum_date <= soybean_meal_gap_first
        and maximum_date >= soybean_meal_gap_last
    )
    target_files_present = sum(item["present"] for item in target_files)

    report = {
        "schemaVersion": 1,
        "purpose": "huggingface-domestic-futures-ticks-gap-source-probe",
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {
            "datasetId": DATASET_ID,
            "url": f"https://huggingface.co/datasets/{DATASET_ID}",
            "apiUrl": DATASET_API,
            "treeApiUrl": TREE_API,
            "commit": PINNED_COMMIT,
            "lastModified": dataset.get("lastModified"),
            "private": dataset.get("private"),
            "gated": dataset.get("gated"),
            "usedStorageBytes": dataset.get("usedStorage"),
            "declaredLicense": dataset.get("cardData", {}).get("license"),
            "readme": {
                "url": README_URL,
                "sha256": sha256_text(readme),
                "content": readme,
                "documentsUpstreamProvider": False,
                "documentsAcquisitionMethod": False,
                "documentsRedistributionAuthority": False,
            },
            "inventory": {
                "datasetSiblingCount": len(sibling_paths),
                "treeFileCount": len(tree_file_paths),
                "treeMatchesDatasetSiblings": tree_file_paths == sibling_paths,
            },
            "normalizedManifestSha256": normalized_manifest_sha256(tree),
        },
        "target": {
            "instrumentCount": len(TARGETS),
            "presentInstrumentCount": target_files_present,
            "allTargetFilesPresent": target_files_present == len(TARGETS),
            "missingSymbols": [
                item["symbol"] for item in target_files if not item["present"]
            ],
            "files": target_files,
        },
        "sample": {
            "file": SAMPLE_FILE,
            "repositorySize": sample_entry.get("size"),
            "lfsSha256": lfs_sha256,
            "fileCommit": sample_entry.get("lastCommit"),
            "download": {
                **download,
                "sha256MatchesLfsOid": (
                    bool(lfs_sha256) and download["sha256"] == lfs_sha256
                ),
            },
            **sample,
        },
        "rights": {
            "datasetLicenseClaimPresent": bool(
                dataset.get("cardData", {}).get("license"),
            ),
            "datasetLicenseIdentifier": dataset.get("cardData", {}).get("license"),
            "upstreamMarketDataProviderDocumented": False,
            "upstreamMarketDataAcquisitionDocumented": False,
            "upstreamRedistributionAuthorityDocumented": False,
            "gitStorageAllowed": False,
            "packagedApplicationRedistributionAllowed": False,
            "derivedBarsRedistributionAllowed": False,
            "commercialUseAllowed": False,
        },
        "coverage": {
            "sampleFirstDate": minimum_date.isoformat(),
            "sampleLastDate": maximum_date.isoformat(),
            "partialSoybeanMealTargetGapCoverageConfirmed": partial_gap_coverage,
            "completeSoybeanMealTargetGapCoverageConfirmed": (
                complete_soybean_meal_gap_coverage
            ),
            "allTargetGapCoverageConfirmed": False,
            "threeYearHistoryConfirmed": (
                (maximum_date - minimum_date).days >= 3 * 365
            ),
            "concreteContractAttributionAvailable": (
                sample["concreteContractAttributionAvailable"]
            ),
            "historicalMainContractMappingCapabilityConfirmed": False,
        },
        "retention": {
            "sampleStoredOnlyInTemporaryDirectory": True,
            "temporarySampleDeletedAfterProbe": True,
            "temporaryPyarrowEnvironmentManagedByRunner": True,
            "rawParquetPersisted": False,
            "rawRowsPersisted": False,
            "summaryOnly": True,
        },
        "conclusion": {
            "technicalTargetGapCoverageConfirmed": False,
            "redistributionPermissionConfirmed": False,
            "releaseEligibility": (
                "blocked-incomplete-target-set-and-gap-no-contract-attribution-"
                "and-upstream-rights-unconfirmed"
            ),
            "note": (
                "The dataset contains 13 of 15 target products and omits RM and OI. "
                "The soybean-meal sample covers only part of the July-October 2025 "
                "gap, identifies a continuous 9999 symbol instead of concrete "
                "delivery contracts, and does not provide three years of history. "
                "Its dataset card declares MIT but does not document the upstream "
                "market-data provider, acquisition method, or redistribution authority."
            ),
        },
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Generated Hugging Face futures probe summary: {output}")


if __name__ == "__main__":
    main()
