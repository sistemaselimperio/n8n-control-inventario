"""Dobles de prueba para la capa de base de datos (asyncpg) en los tests
unitarios: ninguna prueba unitaria abre una conexion real.

La idea es "guionar" respuestas por fragmento de SQL: cada regla dice que
devolver cuando la consulta contiene cierto texto. Todo lo que se ejecuta
queda registrado en `llamadas`, para poder afirmar sobre el SQL y los
argumentos (por ejemplo, que el insert a `logs` ocurrio con el evento esperado).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

_DEFECTO = {"fetch": [], "fetchrow": None, "fetchval": None, "execute": "OK"}


class FakeConn:
    def __init__(self) -> None:
        # (metodo, sql, args) en orden de ejecucion.
        self.llamadas: list[tuple[str, str, tuple]] = []
        self._reglas: list[tuple[str, str, list[Any]]] = []

    def responder(self, metodo: str, fragmento: str, *valores: Any) -> "FakeConn":
        """Registra la respuesta para `metodo` cuando el SQL contiene `fragmento`.

        Con varios `valores` se consumen en orden y el ultimo se repite. Un valor
        que sea una excepcion se lanza; un callable recibe los argumentos del SQL.
        """
        self._reglas.append((metodo, fragmento, list(valores)))
        return self

    async def _resolver(self, metodo: str, sql: str, args: tuple) -> Any:
        self.llamadas.append((metodo, sql, args))
        for m, fragmento, valores in self._reglas:
            if m == metodo and fragmento in sql:
                valor = valores.pop(0) if len(valores) > 1 else valores[0]
                if isinstance(valor, BaseException):
                    raise valor
                if callable(valor):
                    return valor(*args)
                return valor
        return _DEFECTO[metodo]

    async def fetch(self, sql: str, *args: Any) -> Any:
        return await self._resolver("fetch", sql, args)

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        return await self._resolver("fetchrow", sql, args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self._resolver("fetchval", sql, args)

    async def execute(self, sql: str, *args: Any) -> Any:
        return await self._resolver("execute", sql, args)

    @asynccontextmanager
    async def transaction(self):
        # Sin rollback real: la excepcion simplemente se propaga, que es lo
        # unico que el codigo de produccion observa.
        yield

    # ---- Ayudas para afirmar ----

    def sql_ejecutado(self, fragmento: str) -> list[tuple[str, str, tuple]]:
        return [c for c in self.llamadas if fragmento in c[1]]

    def eventos_log(self) -> list[str]:
        """Nombres de evento escritos en `logs`, en orden."""
        return [c[2][0] for c in self.llamadas if "insert into logs" in c[1]]

    def inserts_log(self) -> list[tuple]:
        return [c[2] for c in self.llamadas if "insert into logs" in c[1]]


class FakePool:
    """Imita a asyncpg.Pool: delega todo en una unica FakeConn compartida."""

    def __init__(self, conn: FakeConn | None = None) -> None:
        self.conn = conn or FakeConn()

    @asynccontextmanager
    async def acquire(self):
        yield self.conn

    async def fetch(self, sql: str, *args: Any) -> Any:
        return await self.conn.fetch(sql, *args)

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        return await self.conn.fetchrow(sql, *args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return await self.conn.fetchval(sql, *args)

    async def execute(self, sql: str, *args: Any) -> Any:
        return await self.conn.execute(sql, *args)


def violacion_unica(constraint: str) -> Exception:
    """UniqueViolationError con el nombre de constraint que lee duplicates.py."""
    import asyncpg

    exc = asyncpg.UniqueViolationError("duplicate key value violates unique constraint")
    exc.constraint_name = constraint
    return exc

