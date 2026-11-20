"""Read only the literal, nonsecret selection confirmation and preserve its recovery evidence."""
import hashlib
import re
import sys
from pathlib import Path

KEY = "SELECTION_CONFIRMED_VERSION"
LITERAL = r"selection-score(?:-global)?(?:-shared(?:-standard)?)?@[0-9a-f]{10,64}\+weights@[0-9a-f]{10,64}"
DEFINITION = re.compile(r"^[ \t]*(?:export[ \t]+)?" + KEY + r"\b")
VALUE = re.compile(rf"""[ \t]*=[ \t]*(?:"({LITERAL}|)"|'({LITERAL}|)'|({LITERAL}|))(?:[ \t]+\#.*)?[ \t]*""")


def selection_field(path):
    line = None
    value = None
    with path.open() as env:
        for raw in env:
            definition = DEFINITION.match(raw)
            if not definition:
                continue
            if line is not None:
                raise ValueError("Ambiguous selection confirmation")
            line = raw.rstrip("\n")
            match = VALUE.fullmatch(line, definition.end())
            if not match:
                raise ValueError("Selection confirmation must be a supported literal or empty")
            value = next(part for part in match.groups() if part is not None)
    return {"present": line is not None, "value": value,
            "definition_sha256": hashlib.sha256(line.encode()).hexdigest() if line is not None else None}


if __name__ == "__main__":
    print(selection_field(Path(sys.argv[1]))["value"] or "")
