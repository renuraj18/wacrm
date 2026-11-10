"use client";

// ============================================================
// Settings → Message retention. Messages older than the chosen period move
// to the archive; contacts are never deleted. Admins only.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RETENTION_CHOICES } from "@/lib/messages/retention";

interface Status {
  months: number;
  lastArchivedAt: string | null;
  lastArchivedCount: number;
}

export function MessageRetention() {
  const [status, setStatus] = useState<Status | null>(null);
  const [months, setMonths] = useState<number>(3);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    fetch("/api/settings/retention")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load");
        setStatus(data);
        setMonths(data.months);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not load"));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/retention", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setStatus(data);
      toast.success("Retention saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!window.confirm(`Move all messages older than ${months} months to the archive now? Contacts are kept.`)) return;
    setArchiving(true);
    try {
      const res = await fetch("/api/settings/retention/archive", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not archive");
      setStatus(data.status);
      toast.success(`${data.moved} message${data.moved === 1 ? "" : "s"} archived`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not archive");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Message retention</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Messages older than this move out of the inbox into the archive. Contacts are never deleted.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="retention-months" className="text-sm text-foreground">Keep messages for</label>
        <select
          id="retention-months"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          {RETENTION_CHOICES.map((m) => (
            <option key={m} value={m}>{m} {m === 1 ? "month" : "months"}</option>
          ))}
        </select>
        <Button onClick={save} disabled={saving || !status || months === status.months}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="text-sm text-muted-foreground">
        {status?.lastArchivedAt
          ? `Last archived ${new Date(status.lastArchivedAt).toLocaleString("en-IN")}: ${status.lastArchivedCount} messages moved.`
          : "Nothing archived yet."}
      </div>

      <Button variant="outline" onClick={archive} disabled={archiving}>
        {archiving ? "Archiving…" : "Archive now"}
      </Button>
    </div>
  );
}
