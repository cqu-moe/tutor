#!/usr/bin/env python3
import json
import subprocess
import sys
import xml.etree.ElementTree as ET


def flatten(outline, level=1):
    items = []
    for child in outline:
        if child.tag == "outline":
            items.extend(flatten(child, level + 1))
        elif child.tag == "item":
            title = " ".join(child.itertext()).strip()
            page = int(child.get("page", "0"))
            if title and page > 0:
                items.append({"title": title, "page": page, "level": level})
    return items


result = subprocess.run(
    ["pdftohtml", "-xml", "-stdout", "-i", "-f", "1", "-l", "1", sys.argv[1]],
    check=True,
    capture_output=True,
)
outline = ET.fromstring(result.stdout).find("outline")
print(json.dumps(flatten(outline) if outline is not None else [], ensure_ascii=False))
