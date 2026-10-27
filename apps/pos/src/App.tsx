import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import "./App.css";

type DatabaseStatus = "checking" | "connected" | "unavailable";

export default function App() {
  const [status, setStatus] = useState<DatabaseStatus>("checking");
  const [tables, setTables] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function checkDatabase() {
    setStatus("checking");
    setError("");

    try {
      const db = await Database.load("sqlite:secret-kids-club.db");
      const result = await db.select<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      );

      setTables(result.map((table) => table.name));
      setStatus("connected");
    } catch (err) {
      setStatus("unavailable");
      setError(
        err instanceof Error
          ? err.message
          : "Database connection is unavailable."
      );
    }
  }

  useEffect(() => {
    void checkDatabase();
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">SK</div>
        <div>
          <h1>Secret Kids Club</h1>
          <p>Point of Sale · Local System</p>
        </div>
        <span className="environment-label">POS</span>
      </header>

      <section className="welcome">
        <p className="eyebrow">CASHIER WORKSPACE</p>
        <h2>System readiness</h2>
        <p>
          Check the local database connection before enabling cashier
          operations.
        </p>
      </section>

      <section className="status-card">
        <div className="status-heading">
          <div>
            <h3>Local database</h3>
            <p>SQLite · secret-kids-club.db</p>
          </div>
          <span className={`status-pill ${status}`}>
            {status === "checking"
              ? "Checking"
              : status === "connected"
                ? "Connected"
                : "Unavailable"}
          </span>
        </div>

        {status === "connected" ? (
          <>
            <div className="metric">
              <span>Tables detected</span>
              <strong>{tables.length}</strong>
            </div>
            <p className="detail">
              Database connection succeeded. This check does not create
              visits, sales, payments, or stock movements.
            </p>
            {tables.length > 0 && (
              <details>
                <summary>View database tables</summary>
                <ul className="table-list">
                  {tables.map((table) => (
                    <li key={table}>{table}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : status === "checking" ? (
          <p className="detail">Checking the local database connection…</p>
        ) : (
          <p className="error-message">
            {error || "The database could not be opened."}
            <br />
            Run this screen inside the native Tauri application to test
            SQLite. A successful browser build alone does not test SQLite.
          </p>
        )}

        <button
          className="retry-button"
          onClick={() => void checkDatabase()}
          disabled={status === "checking"}
        >
          {status === "checking" ? "Checking…" : "Check connection again"}
        </button>
      </section>

      <footer>
        <span>Secret Kids Club POS</span>
        <span>Local-first setup · Initial diagnostic</span>
      </footer>
    </main>
  );
}
