from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    app_name: str = "VC Backend"
    debug: bool = True
    database_url: str = "postgresql+asyncpg://vc:vc_secret_change_me@db:5432/vc_db"
    redis_url: str = "redis://redis:6379/0"


settings = Settings()
