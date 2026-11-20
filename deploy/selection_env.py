"""Read only the literal, nonsecret selection confirmation for the release wrapper."""
import re
import sys
from pathlib import Path

KEY = "SELECTION_CONFIRMED_VERSION"
LITERAL = r"selection-score(?:-global)?(?:-shared(?:-standard)?)?@[0-9a-f]{10,64}\+weights@[0-9a-f]{10,64}"
DEFINITION = re.compile(r"^[ \t]*(?:export[ \t]+)?" + KEY + r"\b")
VALUE = re.compile(rf"""[ \t]*=[ \t]*(?:"({LITERAL}|)"|'({LITERAL}|)'|({LITERAL}|))(?:[ \t]+\#.*)?[ \t]*""")


def read_confirmation(path):
    value = None
    with path.open() as env:
        for raw in env:
            definition = DEFINITION.match(raw)
            if not definition:
                continue
            if value is not None:
                raise ValueError("Ambiguous selection confirmation")
            line = raw.rstrip("\n")
            match = VALUE.fullmatch(line, definition.end())
            if not match:
                raise ValueError("Selection confirmation must be a supported literal or empty")
            value = next(part for part in match.groups() if part is not None)
    return value or ""


if __name__ == "__main__":
    print(read_confirmation(Path(sys.argv[1])))
