from app.database.base import Base
from app.database.models.coin import Coin
from app.database.models.market_data import Candle, TickerSnapshot
from app.database.models.system_log import SystemLog

# Imported for their side effect on Base.metadata: a model that is never
# imported does not exist as far as create_all() and Alembic autogenerate are
# concerned, and both would silently omit the table.
from app.paper.models import PaperTrade, PortfolioSnapshot

__all__ = [
    "Base",
    "Candle",
    "Coin",
    "PaperTrade",
    "PortfolioSnapshot",
    "SystemLog",
    "TickerSnapshot",
]
