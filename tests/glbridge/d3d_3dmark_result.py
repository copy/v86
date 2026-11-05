#!/usr/bin/env python3
"""Extract benchmark-only evidence from a local 3DMark .3dr ZIP.

Registration keys, comments and the machine inventory are deliberately not
copied. Unsupported statuses and unit exponents are preserved; this parser
does not turn a saved score into an acceptance verdict.
"""
import argparse
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


SETTINGS = {
    "Width", "Height", "Anti-Aliasing", "Anti-Aliasing Quality",
    "Post-Processing", "Texture Filtering", "Max Anisotropy",
    "Vertex Shaders", "Force PS 1.1 in GT2 & GT3", "Repeat Tests",
    "Fixed Framerate", "Checksums Valid", "Display Changed", "NullPS",
    "Invalid Score", "VS Profile", "PS Profile", "Force Full Precision",
    "Disable DST", "Disable Post-Processing", "Force Software Vertex Shaders",
    "Force Software Vertex Shader", "Color Mipmaps",
    "Anisotropic Level", "Force full precision", "Disable HW shadow mapping",
    "Disable post-processing", "Force software vertex shader", "Color mipmaps",
    "Force software FP filtering", "Repeat tests", "Fixed framerate",
}


def extract(filename):
    with zipfile.ZipFile(filename) as archive:
        entry = archive.getinfo("Result.xml")
        if entry.file_size > 1024 * 1024:
            raise ValueError("Result.xml exceeds the evidence reader limit")
        root = ET.fromstring(archive.read(entry))
    if root.tag != "Benchmark" or not root.findtext("Version"):
        raise ValueError("Unrecognized benchmark result schema")
    result = {"version": root.findtext("Version"), "settings": {}, "results": []}
    for setting in root.findall("Setting"):
        name = setting.findtext("Name/EnumValue/Formatted")
        if name in SETTINGS:
            result["settings"][name] = setting.findtext("Values/EnumValue/Formatted")
    for row in root.findall("Result"):
        name = row.findtext("Name/EnumValue/Formatted")
        value = row.find("ResultValue")
        status = row.findtext("Status/EnumValue/Plain")
        if not name or value is None or status is None or not math.isfinite(float(value.text)):
            raise ValueError("Incomplete benchmark result row")
        result["results"].append({
            "test": name, "value": value.text, "unit": value.get("unit"),
            "base": int(value.get("base", "10")), "exp": int(value.get("exp", "0")),
            "status": status, "status_text": row.findtext("Status/EnumValue/Formatted"),
        })
    if not result["results"]:
        raise ValueError("No benchmark results found")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = extract(args.input)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Extracted {len(result['results'])} result rows to {args.output}")
