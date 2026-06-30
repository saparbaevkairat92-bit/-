import logging
import re

_SECRET_PATTERNS = [
    re.compile(r"(token|key|secret|password|authorization)[=:\s]+\S+", re.IGNORECASE),
    re.compile(r"Bearer\s+\S+", re.IGNORECASE),
]


class SanitizingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _sanitize(str(record.msg))
        record.args = tuple(_sanitize(str(a)) for a in record.args) if record.args else record.args
        return True


def _sanitize(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda m: m.group(0).split(m.group(0)[-len(m.group(0))//2:])[0] + "***", text)
    return text


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(SanitizingFilter())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[handler],
    )
