import time
from collections import defaultdict, deque

from fastapi import HTTPException, status

_hits: dict[str, deque[float]] = defaultdict(deque)


def check(user_id: str, limit_per_min: int) -> None:
    """Плаваюче вікно на хвилину, у пам'яті процесу.

    Цього достатньо для одного інстансу. Якщо колись буде кілька —
    рахунок доведеться винести назовні, інакше ліміт помножиться.
    """
    now = time.monotonic()
    window = _hits[user_id]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= limit_per_min:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "rate_limited")
    window.append(now)
