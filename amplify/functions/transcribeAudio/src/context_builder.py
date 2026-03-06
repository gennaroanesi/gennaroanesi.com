"""
context_builder.py

Assembles flight + airport + approach + fix context from DynamoDB.
This context is injected into both the Whisper prompt and the Claude correction prompt,
dramatically improving accuracy on domain-specific terms (callsigns, fixes, frequencies).
"""

import os
import json
import boto3
from boto3.dynamodb.conditions import Key
from typing import TypedDict

dynamo = boto3.resource("dynamodb")

FLIGHT_TABLE    = os.environ["FLIGHT_TABLE_NAME"]
AIRPORT_TABLE   = os.environ["AIRPORT_TABLE_NAME"]
APPROACH_TABLE  = os.environ["APPROACH_TABLE_NAME"]
PROCEDURE_TABLE = os.environ["PROCEDURE_TABLE_NAME"]


class FlightContext(TypedDict):
    flight_id:     str
    date:          str
    aircraft_id:   str       # N-number, e.g. "N52407"
    aircraft_type: str       # e.g. "C172"
    from_icao:     str
    to_icao:       str
    airports:      list[dict]          # [{icao, name, city, state}]
    approach_types: str                # raw string from flight record
    approaches:    list[dict]          # [{label, icao, procedure, runway}]
    fixes:         list[str]           # all fix names across all approaches
    frequencies:   list[str]           # known frequencies (from instrumentApproach + manual)
    whisper_prompt: str                # ready-to-use Whisper initial_prompt
    claude_context: str                # ready-to-use Claude system context block


def _scan_all(table_name: str, filter_expr=None, expr_values=None) -> list[dict]:
    table = dynamo.Table(table_name)
    kwargs = {}
    if filter_expr:
        from boto3.dynamodb.conditions import Attr
        kwargs["FilterExpression"] = filter_expr
    if expr_values:
        kwargs["ExpressionAttributeValues"] = expr_values
    results = []
    resp = table.scan(**kwargs)
    results.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)
        results.extend(resp.get("Items", []))
    return results


def _scan_by_attr(table_name: str, attr: str, value: str) -> list[dict]:
    """Scan a table filtering by a non-key attribute (for tables with no GSI on that field)."""
    from boto3.dynamodb.conditions import Attr
    table = dynamo.Table(table_name)
    results = []
    resp = table.scan(FilterExpression=Attr(attr).eq(value))
    results.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.scan(
            FilterExpression=Attr(attr).eq(value),
            ExclusiveStartKey=resp["LastEvaluatedKey"],
        )
        results.extend(resp.get("Items", []))
    return results


def _query_gsi(table_name: str, index: str, key_name: str, key_val: str) -> list[dict]:
    table = dynamo.Table(table_name)
    results = []
    resp = table.query(
        IndexName=index,
        KeyConditionExpression=Key(key_name).eq(key_val),
    )
    results.extend(resp.get("Items", []))
    while "LastEvaluatedKey" in resp:
        resp = table.query(
            IndexName=index,
            KeyConditionExpression=Key(key_name).eq(key_val),
            ExclusiveStartKey=resp["LastEvaluatedKey"],
        )
        results.extend(resp.get("Items", []))
    return results


def build(flight_id: str) -> FlightContext:
    # ── 1. Fetch flight record ──────────────────────────────────────────────
    flight_table = dynamo.Table(FLIGHT_TABLE)
    resp = flight_table.get_item(Key={"id": flight_id})
    flight = resp.get("Item", {})

    aircraft_id   = flight.get("aircraftId", "")
    aircraft_type = flight.get("aircraftType", "")
    from_icao     = flight.get("from", "")
    to_icao       = flight.get("to", "")
    date          = flight.get("date", "")
    approach_types_raw = flight.get("approachTypes", "") or ""

    # ── 2. Fetch airport records for departure + destination ────────────────
    airports = []
    for icao in set([from_icao, to_icao]):
        if not icao:
            continue
        rows = _query_gsi(AIRPORT_TABLE, "airportsByIcaoId", "icaoId", icao)
        if rows:
            a = rows[0]
            airports.append({
                "icao":  icao,
                "name":  a.get("name", ""),
                "city":  a.get("city", ""),
                "state": a.get("stateCode", ""),
            })

    # ── 3. Fetch instrument approaches for all airports ─────────────────────
    # InstrumentApproach table uses nasrSiteNo as PK — we need to find
    # the nasrSiteNo for each airport first, then query approaches.
    all_approaches = []
    frequencies = []

    airport_table = dynamo.Table(AIRPORT_TABLE)
    for icao in set([from_icao, to_icao]):
        if not icao:
            continue
        apt_rows = _query_gsi(AIRPORT_TABLE, "airportsByIcaoId", "icaoId", icao)
        for apt in apt_rows:
            # instrumentApproach has no GSI — scan with filter on airportId
            appr_rows = _scan_by_attr(APPROACH_TABLE, "airportId", apt.get("id", ""))
            for appr in appr_rows:
                freq_str = ""
                # Localizer frequency from instrumentApproach if available
                # (stored as-is from FAA data, e.g. "109.5")
                all_approaches.append({
                    "label":     appr.get("procedureName", ""),
                    "icao":      icao,
                    "procedure": appr.get("procedureName", ""),
                    "runway":    appr.get("runway", ""),
                    "navType":   appr.get("navType", ""),
                })

    # ── 4. Fetch approach procedure fixes from ApproachProcedure table ──────
    fixes: list[str] = []
    all_fix_names: set[str] = set()

    for icao in set([from_icao, to_icao]):
        if not icao:
            continue
        proc_rows = _query_gsi(PROCEDURE_TABLE, "approachProceduresByIcao", "icao", icao)
        for row in proc_rows:
            try:
                fix_list = json.loads(row.get("fixes", "[]"))
                for fix in fix_list:
                    fid = fix.get("fixId", "")
                    if fid and len(fid) >= 3:
                        all_fix_names.add(fid)
            except Exception:
                pass

    fixes = sorted(all_fix_names)

    # ── 5. Build Whisper initial_prompt ─────────────────────────────────────
    # Whisper uses this to prime its decoder — domain vocab dramatically improves accuracy.
    airport_names = ", ".join(f"{a['icao']} {a['name']}" for a in airports)
    fix_str       = ", ".join(fixes[:40]) if fixes else "none"  # cap to avoid exceeding prompt size
    appr_str      = ", ".join(set(a["label"] for a in all_approaches[:10]))

    whisper_prompt = (
        f"ATC radio transcript. Aircraft: {aircraft_id} ({aircraft_type}). "
        f"Airports: {airport_names}. Date: {date}. "
        f"Approaches: {appr_str}. "
        f"Waypoints and fixes: {fix_str}. "
        "Phraseology: cleared, descend and maintain, fly heading, contact, "
        "squawk, ident, report, traffic, roger, wilco, unable, standby, "
        "altimeter, winds, runway, ILS, RNAV, localizer, glideslope, "
        "decision altitude, minimum descent altitude, missed approach."
    )

    # ── 6. Build Claude correction context ──────────────────────────────────
    claude_context = (
        f"You are correcting an ASR transcript of ATC radio communications.\n\n"
        f"Flight context:\n"
        f"- Aircraft: {aircraft_id} ({aircraft_type})\n"
        f"- Date: {date}\n"
        f"- Departure: {from_icao}, Destination: {to_icao}\n"
        f"- Airports: {airport_names}\n"
        f"- Approaches flown: {approach_types_raw}\n"
        f"- Known fixes/waypoints: {fix_str}\n"
        f"- Known instrument approaches: {appr_str}\n\n"
        f"Instructions:\n"
        f"1. Correct aircraft callsign to: {aircraft_id}\n"
        f"2. Correct waypoint/fix names to standard ICAO spelling\n"
        f"3. Expand abbreviated phraseology to standard form\n"
        f"4. Correct frequencies to standard MHz format (e.g. '132.025')\n"
        f"5. Correct runway numbers (e.g. 'two three' → 'Runway 23')\n"
        f"6. Preserve speaker attribution exactly\n"
        f"7. Return ONLY the corrected text for the segment, no explanation\n"
    )

    return FlightContext(
        flight_id=flight_id,
        date=date,
        aircraft_id=aircraft_id,
        aircraft_type=aircraft_type,
        from_icao=from_icao,
        to_icao=to_icao,
        airports=airports,
        approach_types=approach_types_raw,
        approaches=all_approaches,
        fixes=fixes,
        frequencies=frequencies,
        whisper_prompt=whisper_prompt,
        claude_context=claude_context,
    )
