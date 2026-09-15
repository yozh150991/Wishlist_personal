from pydantic import BaseModel, Field


class ParseRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


class ParseResponse(BaseModel):
    url: str
    title: str | None = None
    price: float | None = None
    currency: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    # Звідки взялось кожне поле: 'jsonld' | 'microdata' | 'og' | 'twitter' | 'title'
    confidence: dict[str, str] = {}
    # true, якщо щось витягти не вдалося. Це не помилка — клієнт
    # відкриває форму з тим, що є, і дає дописати руками.
    partial: bool = False
