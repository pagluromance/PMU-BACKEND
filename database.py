"""
Database connection setup.

Using SQLite for now — zero setup, works out of the box, stored as a single
file (pmu_data.db). When you're ready to move to PostgreSQL/TimescaleDB for
production, you only need to change DATABASE_URL below (and add the
psycopg2-binary package to requirements.txt). Nothing else in the code
changes, since SQLAlchemy abstracts the database engine.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./pmu_data.db")

# check_same_thread=False is only needed for SQLite (allows use across
# FastAPI's async request handling). Remove this connect_args if you switch
# to PostgreSQL.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency: gives each request its own DB session, closes it after."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
