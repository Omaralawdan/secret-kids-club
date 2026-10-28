import { useCallback, useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import "./App.css";
import { t, useLanguage, type Language } from "./i18n";

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
  durationHours: number;
};

type Screen = "reception" | "pricing" | "settings";

const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const money = (minor: number, language: Language = "en") =>
  new Intl.NumberFormat(language === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
  }).format(minor / 100);

export default function App() {
  const { language, setLanguage } = useLanguage();
  const tr = (key: string) => t(language, key);
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
    { key: makeId(), name: "", ruleId: "", durationHours: 1 },
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

  function updateChild(
    key: string,
    field: "name" | "ruleId" | "durationHours",
    value: string | number
  ) {
    setChildren((current) =>
      current.map((child) => {
        if (child.key !== key) return child;
        if (field === "durationHours") {
          return { ...child, durationHours: Number(value) };
        }
        return { ...child, [field]: value };
      })
    );
  }

  function addChild() {
    setChildren((current) => [
      ...current,
      { key: makeId(), name: "", ruleId: "", durationHours: 1 },
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

    // Only hourly rules multiply by the booked duration.
    // Fixed and offer prices remain unchanged.
    if (rule.pricing_type === "hourly") {
      return Math.round(rule.amount_minor * child.durationHours);
    }

    return rule.amount_minor;
  }

  const total = children.reduce((sum, child) => sum + priceFor(child), 0);
  const ready = databaseStatus === "Connected" && db !== null;

  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) return;

    const amount = Number(ruleAmount);
    if (!ruleName.trim() || !Number.isFinite(amount) || amount < 0) {
      setError(tr("Enter a rule name and a valid non-negative price."));
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
      setMessage(tr("Pricing rule saved."));
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
      setError(tr("Enter the guardian's name and phone number."));
      return;
    }

    if (cleanChildren.some((child) => !child.name || !child.ruleId)) {
      setError(tr("Enter each child's name and select a pricing rule for every child."));
      return;
    }

    if (cleanChildren.some((child) => !rules.some((rule) => rule.id === child.ruleId))) {
      setError(tr("A selected pricing rule is no longer available. Refresh and try again."));
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
        if (!selectedRule) throw new Error(tr("Pricing rule not found."));

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
            priceFor(row.child),
            priceFor(row.child),
            selectedRule.pricing_type === "hourly"
              ? Math.round(row.child.durationHours * 60)
              : 0,
            JSON.stringify({
              ruleName: selectedRule.name,
              pricingType: selectedRule.pricing_type,
              initialEstimate: selectedRule.pricing_type === "hourly",
              bookedDurationMinutes:
                selectedRule.pricing_type === "hourly"
                  ? Math.round(row.child.durationHours * 60)
                  : null,
              hourlyRateMinor:
                selectedRule.pricing_type === "hourly"
                  ? selectedRule.amount_minor
                  : null,
            }),
            timestamp,
          ]
        );
      }

      await refreshData(db);
      setGuardianName("");
      setGuardianPhone("");
      setGuardianRelation("Mother");
      setChildren([
        { key: makeId(), name: "", ruleId: "", durationHours: 1 },
      ]);
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
          <p>{tr('Point of Sale · Local System')}</p>
        </div>
        <span className={`connection ${ready ? "online" : "offline"}`}>
          {tr(databaseStatus)}
        </span>
      </header>

      <nav className="nav-tabs">
        <button className={screen === "reception" ? "active" : ""} onClick={() => setScreen("reception")}>
          {tr('Reception')}
        </button>
        <button className={screen === "pricing" ? "active" : ""} onClick={() => setScreen("pricing")}>
          {tr('Pricing setup')}
        </button>
        <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
          {tr("Settings")}
        </button>
      </nav>

      <section className="page-heading">
        <p className="eyebrow">{tr('CASHIER WORKSPACE')}</p>
        <h2>{screen === "reception" ? tr("New visit") : screen === "pricing" ? tr("Pricing rules") : tr("Settings")}</h2>
        <p>
          {screen === "reception"
            ? tr("Register a guardian and each child, then review their individual pricing.")
            : screen === "pricing"
              ? tr("Configure the prices available to cashiers. No prices are preloaded.")
              : tr("Choose the language used throughout the application.")}
        </p>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}

      {!ready && screen !== "settings" && (
        <section className="panel database-warning" role="status">
          <h3>{tr("Local database")}</h3>
          <p>
            {databaseStatus === "Connecting"
              ? tr("Connecting to SQLite…")
              : tr("The database is unavailable.")}
          </p>
          <p>
            {tr("The screens are available, but saving requires the app database connection.")}
          </p>
        </section>
      )}

      {screen === "settings" ? (
        <section className="panel settings-panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>{tr("Settings")}</h3></div>
          </div>
          <p className="muted intro">{tr("Choose the language used throughout the application.")}</p>
          <label>
            {tr("Language")}
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}
            >
              <option value="en">{tr("English")}</option>
              <option value="ar">{tr("Arabic")}</option>
            </select>
          </label>
        </section>
      ) : screen === "reception" ? (
        <form className="workspace" onSubmit={createVisit}>
          <section className="panel">
            <div className="panel-title">
              <div><span className="step">01</span><h3>{tr('Guardian information')}</h3></div>
              <span className="muted">{tr('Required')}</span>
            </div>
            <div className="form-grid">
              <label>{tr('Guardian full name')}
                <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required placeholder={tr("Full name")} />
              </label>
              <label>{tr('Relationship')}
                <select value={guardianRelation} onChange={(e) => setGuardianRelation(e.target.value)}>
                  {["Mother", "Father", "Guardian", "Relative", "Other"].map((item) => <option key={item} value={item}>{tr(item)}</option>)}
                </select>
              </label>
              <label className="full-width">{tr('Phone number')}
                <input value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} required inputMode="tel" placeholder={tr("Guardian phone")} />
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div><span className="step">02</span><h3>{tr('Children and pricing')}</h3></div>
              <span className="muted">{children.length} {tr(children.length === 1 ? "child" : "children")}</span>
            </div>
            {rules.length === 0 && (
              <div className="empty-state">
                <strong>{tr("No pricing rules configured yet.")}</strong>
                <p>{tr("Open Pricing setup and add your actual prices before registering a visit.")}</p>
                <button type="button" className="secondary-button" onClick={() => setScreen("pricing")}>{tr("Set up pricing")}</button>
              </div>
            )}
            <div className="children-list">
              {children.map((child, index) => {
                const selected = rules.find((rule) => rule.id === child.ruleId);
                return (
                  <div className="child-row" key={child.key}>
                    <div className="child-number">{index + 1}</div>
                    <label className="child-name">{tr('Child name')}
                      <input value={child.name} onChange={(e) => updateChild(child.key, "name", e.target.value)} required placeholder={tr("Child's name")} />
                    </label>
                    <label className="child-pricing">{tr('Pricing rule')}
                      <select value={child.ruleId} onChange={(e) => updateChild(child.key, "ruleId", e.target.value)} required>
                        <option value="">{tr('Select price')}</option>
                        {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} · {tr(rule.pricing_type)}</option>)}
                      </select>
                      {selected?.pricing_type === "hourly" && (
                        <div className="booked-hours-field">
                          <span>{language === "ar" ? "عدد الساعات المحجوزة" : "Booked hours"}</span>
                          <input
                            type="number"
                            min="0.5"
                            max="12"
                            step="0.5"
                            required
                            value={child.durationHours}
                            onChange={(e) =>
                              updateChild(
                                child.key,
                                "durationHours",
                                Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      )}
                    </label>
                    <div className="child-price">
                      <span>{tr('Price estimate')}</span>
                      <strong>{selected ? money(priceFor(child), language) : "—"}</strong>
                    </div>
                    <button type="button" className="remove-button" onClick={() => removeChild(child.key)} disabled={children.length === 1} aria-label={`Remove child ${index + 1}`}>×</button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="secondary-button add-child" onClick={addChild}>{`+ ${tr("Add another child")}`}</button>
          </section>

          <section className="summary-panel">
            <div>
              <span className="muted">{tr('Initial visit total')}</span>
              <strong className="total">{money(total, language)}</strong>
              <p>
                {language === "ar"
                  ? "قبل الخصومات · السعر بالساعة محسوب حسب مدة الحجز"
                  : "Before discounts · Hourly pricing uses the booked duration"}
              </p>
            </div>
            <button className="primary-button" type="submit" disabled={!ready || saving || rules.length === 0}>
              {saving ? tr("Saving visit…") : tr("Confirm check-in")}
            </button>
          </section>
        </form>
      ) : (
        <section className="panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>{tr('Add a pricing rule')}</h3></div>
          </div>
          <p className="muted intro">{tr("Enter the real price used by your club. Prices are stored in EGP.")}</p>
          <form className="form-grid" onSubmit={createRule}>
            <label>{tr('Rule name')}
              <input value={ruleName} onChange={(e) => setRuleName(e.target.value)} required placeholder={tr("e.g. Standard entry")} />
            </label>
            <label>{tr('Pricing type')}
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as PricingRule["pricing_type"])}>
                <option value="fixed">{tr("Fixed price")}</option>
                <option value="hourly">{tr("Hourly (first-hour estimate)")}</option>
                <option value="offer">{tr("Offer (fixed price)")}</option>
              </select>
            </label>
            <label>{tr('Price in EGP')}
              <input type="number" min="0" step="0.01" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} required placeholder={tr("Enter actual price")} />
            </label>
            <div className="full-width">
              <button className="primary-button" type="submit" disabled={!ready}>{tr('Save pricing rule')}</button>
            </div>
          </form>

          <div className="rule-list">
            <h3>{tr('Active pricing rules')}</h3>
            {rules.length === 0 ? <p className="muted">{tr('No rules configured.')}</p> : rules.map((rule) => (
              <div className="rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong><span>{tr(rule.pricing_type)}</span></div>
                <strong>{money(rule.amount_minor, language)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer>
        <span>Secret Kids Club POS</span>
        <span>{visits} {tr(visits === 1 ? "saved visit" : "saved visits")} · {tr("Local SQLite")}</span>
      </footer>
    </main>
  );
}
