from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    app_name: str = "PettyConf Backend"
    debug: bool = True
    database_url: str = "postgresql+asyncpg://pettyconf:pettyconf_secret_change_me@db:5432/pettyconf_db"
    redis_url: str = "redis://redis:6379/0"


settings = Settings()
