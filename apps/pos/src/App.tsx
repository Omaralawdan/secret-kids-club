import { useCallback, useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import "./App.css";

type PricingRule = {
  id: string;
  name: string;
  pricing_type: "fixed" | "hourly" | "offer";
  amount_minor: number;
  is_active: number;
};

type ChildDraft = {
  key: string;
  name: string;
  ruleId: string;
};

type Screen = "reception" | "pricing";

const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const money = (minor: number) =>
  new Intl.NumberFormat("en-EG", {
    style: "currency",
    currency: "EGP",
  }).format(minor / 100);

export default function App() {
  const [db, setDb] = useState<Database | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState("Connecting");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [screen, setScreen] = useState<Screen>("reception");
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [visits, setVisits] = useState(0);
  const [saving, setSaving] = useState(false);

  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("Mother");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [children, setChildren] = useState<ChildDraft[]>([
    { key: makeId(), name: "", ruleId: "" },
  ]);

  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] =
    useState<PricingRule["pricing_type"]>("fixed");
  const [ruleAmount, setRuleAmount] = useState("");

  const refreshData = useCallback(async (connection: Database) => {
    const loadedRules = await connection.select<PricingRule[]>(
      `SELECT id, name, pricing_type, amount_minor, is_active
       FROM local_pricing_rules
       WHERE is_active = 1 AND calculation_type = 'fixed'
       ORDER BY priority, name`
    );
    setRules(loadedRules);

    const counts = await connection.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM local_visits"
    );
    setVisits(counts[0]?.total ?? 0);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function connect() {
      try {
        const connection = await Database.load("sqlite:secret-kids-club.db");
        await refreshData(connection);
        if (mounted) {
          setDb(connection);
          setDatabaseStatus("Connected");
        }
      } catch (err) {
        if (mounted) {
          setDatabaseStatus("Unavailable");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void connect();
    return () => {
      mounted = false;
    };
  }, [refreshData]);

  function updateChild(key: string, field: "name" | "ruleId", value: string) {
    setChildren((current) =>
      current.map((child) =>
        child.key === key ? { ...child, [field]: value } : child
      )
    );
  }

  function addChild() {
    setChildren((current) => [
      ...current,
      { key: makeId(), name: "", ruleId: "" },
    ]);
  }

  function removeChild(key: string) {
    setChildren((current) =>
      current.length > 1 ? current.filter((child) => child.key !== key) : current
    );
  }

  function priceFor(child: ChildDraft) {
    const rule = rules.find((item) => item.id === child.ruleId);
    if (!rule) return 0;
    // Hourly prices are an initial one-hour estimate. Checkout timing will
    // determine the final amount when the checkout workflow is implemented.
    return rule.amount_minor;
  }

  const total = children.reduce((sum, child) => sum + priceFor(child), 0);
  const ready = databaseStatus === "Connected" && db !== null;

  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) return;

    const amount = Number(ruleAmount);
    if (!ruleName.trim() || !Number.isFinite(amount) || amount < 0) {
      setError("Enter a rule name and a valid non-negative price.");
      return;
    }

    setError("");
    setMessage("");

    try {
      await db.execute(
        `INSERT INTO local_pricing_rules
         (id, name, pricing_type, calculation_type, amount_minor,
          duration_minutes, free_minutes, priority, weekdays_json,
          is_active, created_at)
         VALUES (?, ?, ?, 'fixed', ?, 60, 0, 100, '[]', 1, ?)`,
        [makeId(), ruleName.trim(), ruleType, Math.round(amount * 100), now()]
      );

      setRuleName("");
      setRuleAmount("");
      await refreshData(db);
      setMessage("Pricing rule saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createVisit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || saving) return;

    const cleanChildren = children.map((child) => ({
      ...child,
      name: child.name.trim(),
    }));

    if (!guardianName.trim() || !guardianPhone.trim()) {
      setError("Enter the guardian's name and phone number.");
      return;
    }

    if (cleanChildren.some((child) => !child.name || !child.ruleId)) {
      setError("Enter each child's name and select a pricing rule for every child.");
      return;
    }

    if (cleanChildren.some((child) => !rules.some((rule) => rule.id === child.ruleId))) {
      setError("A selected pricing rule is no longer available. Refresh and try again.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    const visitId = makeId();
    const childRows: { id: string; pricingId: string; child: ChildDraft }[] =
      cleanChildren.map((child) => ({
        id: makeId(),
        pricingId: makeId(),
        child,
      }));
    const createdVisitChildIds: string[] = [];
    let visitInserted = false;

    try {
      const timestamp = now();
      const matchingGuardians = await db.select<{ id: string }[]>(
        "SELECT id FROM local_guardians WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
        [guardianPhone.trim()]
      );

      let guardianId = matchingGuardians[0]?.id;

      if (!guardianId) {
        guardianId = makeId();
        await db.execute(
          "INSERT INTO local_guardians (id, full_name, phone, created_at) VALUES (?, ?, ?, ?)",
          [guardianId, guardianName.trim(), guardianPhone.trim(), timestamp]
        );
      } else {
        await db.execute(
          "UPDATE local_guardians SET full_name = ? WHERE id = ?",
          [guardianName.trim(), guardianId]
        );
      }

      const numberRows = await db.select<{ next_number: number }[]>(
        "SELECT COALESCE(MAX(visit_number_local), 0) + 1 AS next_number FROM local_visits"
      );
      const visitNumber = numberRows[0]?.next_number ?? 1;

      const amountBeforeDiscount = cleanChildren.reduce(
        (sum, child) => sum + priceFor(child),
        0
      );
      const firstRule = rules.find((rule) => rule.id === cleanChildren[0].ruleId);

      await db.execute(
        `INSERT INTO local_visits
         (id, visit_number_local, guardian_id, guardian_name_snapshot,
          guardian_relation, guardian_phone_snapshot, child_count,
          checked_in_at, checked_out_at, status, pricing_type,
          amount_before_discount_minor, discount_amount_minor,
          final_amount_minor, cashier_user_id, sync_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, 0, ?, 'local-cashier', 'pending', ?)`,
        [
          visitId,
          visitNumber,
          guardianId,
          guardianName.trim(),
          guardianRelation,
          guardianPhone.trim(),
          cleanChildren.length,
          timestamp,
          firstRule?.pricing_type ?? "fixed",
          amountBeforeDiscount,
          amountBeforeDiscount,
          timestamp,
        ]
      );
      visitInserted = true;

      for (const row of childRows) {
        const selectedRule = rules.find((rule) => rule.id === row.child.ruleId);
        if (!selectedRule) throw new Error("Pricing rule not found.");

        await db.execute(
          "INSERT INTO local_visit_children (id, visit_id, child_id, child_name_snapshot) VALUES (?, ?, NULL, ?)",
          [row.id, visitId, row.child.name]
        );
        createdVisitChildIds.push(row.id);

        await db.execute(
          `INSERT INTO local_visit_child_pricing
           (id, visit_child_id, pricing_type, pricing_rule_id,
            base_amount_minor, discount_amount_minor, final_amount_minor,
            duration_minutes, included_minutes, calculation_json, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?)`,
          [
            row.pricingId,
            row.id,
            selectedRule.pricing_type,
            selectedRule.id,
            selectedRule.amount_minor,
            selectedRule.amount_minor,
            selectedRule.pricing_type === "hourly" ? 60 : 0,
            JSON.stringify({
              ruleName: selectedRule.name,
              pricingType: selectedRule.pricing_type,
              initialEstimate: selectedRule.pricing_type === "hourly",
            }),
            timestamp,
          ]
        );
      }

      await refreshData(db);
      setGuardianName("");
      setGuardianPhone("");
      setGuardianRelation("Mother");
      setChildren([{ key: makeId(), name: "", ruleId: "" }]);
      setMessage(`Visit #${visitNumber} saved. Initial total: ${money(amountBeforeDiscount)}.`);
    } catch (err) {
      // Best-effort cleanup if a later insert fails. This is not a substitute
      // for a native atomic transaction; production hardening is still needed.
      try {
        for (const childId of createdVisitChildIds) {
          await db.execute(
            "DELETE FROM local_visit_child_pricing WHERE visit_child_id = ?",
            [childId]
          );
          await db.execute("DELETE FROM local_visit_children WHERE id = ?", [childId]);
        }
        if (visitInserted) {
          await db.execute("DELETE FROM local_visits WHERE id = ?", [visitId]);
        }
      } catch {
        // Preserve the original error for the cashier.
      }

      setError(
        `Could not save the visit: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">SK</div>
        <div className="brand-copy">
          <h1>Secret Kids Club</h1>
          <p>Point of Sale · Local System</p>
        </div>
        <span className={`connection ${ready ? "online" : "offline"}`}>
          {databaseStatus}
        </span>
      </header>

      <nav className="nav-tabs">
        <button className={screen === "reception" ? "active" : ""} onClick={() => setScreen("reception")}>
          Reception
        </button>
        <button className={screen === "pricing" ? "active" : ""} onClick={() => setScreen("pricing")}>
          Pricing setup
        </button>
      </nav>

      <section className="page-heading">
        <p className="eyebrow">CASHIER WORKSPACE</p>
        <h2>{screen === "reception" ? "New visit" : "Pricing rules"}</h2>
        <p>
          {screen === "reception"
            ? "Register a guardian and each child, then review their individual pricing."
            : "Configure the prices available to cashiers. No prices are preloaded."}
        </p>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}

      {!ready ? (
        <section className="panel">
          <h3>Local database</h3>
          <p>{databaseStatus === "Connecting" ? "Connecting to SQLite…" : error || "The database is unavailable."}</p>
        </section>
      ) : screen === "reception" ? (
        <form className="workspace" onSubmit={createVisit}>
          <section className="panel">
            <div className="panel-title">
              <div><span className="step">01</span><h3>Guardian information</h3></div>
              <span className="muted">Required</span>
            </div>
            <div className="form-grid">
              <label>Guardian full name
                <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required placeholder="Full name" />
              </label>
              <label>Relationship
                <select value={guardianRelation} onChange={(e) => setGuardianRelation(e.target.value)}>
                  {["Mother", "Father", "Guardian", "Relative", "Other"].map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="full-width">Phone number
                <input value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} required inputMode="tel" placeholder="Guardian phone" />
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div><span className="step">02</span><h3>Children and pricing</h3></div>
              <span className="muted">{children.length} child{children.length === 1 ? "" : "ren"}</span>
            </div>
            {rules.length === 0 && (
              <div className="empty-state">
                <strong>No pricing rules configured yet.</strong>
                <p>Open Pricing setup and add your actual prices before registering a visit.</p>
                <button type="button" className="secondary-button" onClick={() => setScreen("pricing")}>Set up pricing</button>
              </div>
            )}
            <div className="children-list">
              {children.map((child, index) => {
                const selected = rules.find((rule) => rule.id === child.ruleId);
                return (
                  <div className="child-row" key={child.key}>
                    <div className="child-number">{index + 1}</div>
                    <label className="child-name">Child name
                      <input value={child.name} onChange={(e) => updateChild(child.key, "name", e.target.value)} required placeholder="Child's name" />
                    </label>
                    <label className="child-pricing">Pricing rule
                      <select value={child.ruleId} onChange={(e) => updateChild(child.key, "ruleId", e.target.value)} required>
                        <option value="">Select price</option>
                        {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} · {rule.pricing_type}</option>)}
                      </select>
                    </label>
                    <div className="child-price">
                      <span>Price estimate</span>
                      <strong>{selected ? money(priceFor(child)) : "—"}</strong>
                    </div>
                    <button type="button" className="remove-button" onClick={() => removeChild(child.key)} disabled={children.length === 1} aria-label={`Remove child ${index + 1}`}>×</button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="secondary-button add-child" onClick={addChild}>+ Add another child</button>
          </section>

          <section className="summary-panel">
            <div>
              <span className="muted">Initial visit total</span>
              <strong className="total">{money(total)}</strong>
              <p>Before discounts · Hourly prices start with a one-hour estimate</p>
            </div>
            <button className="primary-button" type="submit" disabled={saving || rules.length === 0}>
              {saving ? "Saving visit…" : "Confirm check-in"}
            </button>
          </section>
        </form>
      ) : (
        <section className="panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>Add a pricing rule</h3></div>
          </div>
          <p className="muted intro">Enter the real price used by your club. Prices are stored in EGP.</p>
          <form className="form-grid" onSubmit={createRule}>
            <label>Rule name
              <input value={ruleName} onChange={(e) => setRuleName(e.target.value)} required placeholder="e.g. Standard entry" />
            </label>
            <label>Pricing type
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as PricingRule["pricing_type"])}>
                <option value="fixed">Fixed price</option>
                <option value="hourly">Hourly (first-hour estimate)</option>
                <option value="offer">Offer (fixed price)</option>
              </select>
            </label>
            <label>Price in EGP
              <input type="number" min="0" step="0.01" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} required placeholder="Enter actual price" />
            </label>
            <div className="full-width">
              <button className="primary-button" type="submit">Save pricing rule</button>
            </div>
          </form>

          <div className="rule-list">
            <h3>Active pricing rules</h3>
            {rules.length === 0 ? <p className="muted">No rules configured.</p> : rules.map((rule) => (
              <div className="rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong><span>{rule.pricing_type}</span></div>
                <strong>{money(rule.amount_minor)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer>
        <span>Secret Kids Club POS</span>
        <span>{visits} saved visit{visits === 1 ? "" : "s"} · Local SQLite</span>
      </footer>
    </main>
  );
}
