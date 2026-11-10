"use client";

// ============================================================
// Manual orders — take an order on WhatsApp or the phone. Pick products
// from the live Shopify catalogue, create the draft order, and send the
// checkout link to the customer. Agents and above.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCan } from "@/hooks/use-can";

interface Variant {
  id: string;
  title: string;
  price: string;
  stock: number | null;
  available: boolean;
}
interface Product {
  id: string;
  title: string;
  image: string | null;
  variants: Variant[];
}
interface Line {
  variantId: string | null;
  title: string;
  quantity: number;
  price: string;
}
interface Created {
  order: { name: string; total: string; checkoutUrl: string; items: string };
  whatsapp: { sent: boolean; error?: string };
}

export default function ManualOrdersPage() {
  const canSend = useCan("send-messages");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [shipping, setShipping] = useState("");
  const [discount, setDiscount] = useState("");
  const [note, setNote] = useState("");
  const [sendWhatsApp, setSendWhatsApp] = useState(true);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/manual-orders/products?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed");
        setProducts(data.products);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function addVariant(product: Product, v: Variant) {
    setLines((prev) => [
      ...prev,
      {
        variantId: v.id,
        title: v.title ? `${product.title} – ${v.title}` : product.title,
        quantity: 1,
        price: v.price,
      },
    ]);
  }

  async function create() {
    setSaving(true);
    try {
      const res = await fetch("/api/manual-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName,
          phone,
          items: lines.map((l) => ({ variantId: l.variantId, title: l.title, quantity: l.quantity, price: l.price })),
          shipping,
          discount,
          note,
          sendWhatsApp,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the order");
      setCreated(data);
      toast.success(`Order ${data.order.name} created`);
      setLines([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the order");
    } finally {
      setSaving(false);
    }
  }

  if (!canSend) {
    return <p className="p-6 text-sm text-muted-foreground">You don&apos;t have access to manual orders.</p>;
  }

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-2">
      <section className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">Find products</h1>
        <Input placeholder="Search by name or SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
        {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
        <div className="space-y-2">
          {products.map((p) => (
            <div key={p.id} className="rounded-lg border border-border p-3">
              <p className="font-medium text-foreground">{p.title}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {p.variants.map((v) => (
                  <Button key={v.id} variant="outline" size="sm" disabled={!v.available} onClick={() => addVariant(p, v)}>
                    {(v.title || "Default") + ` · ₹${v.price}`}
                    {v.stock !== null && <span className="ml-1 text-xs text-muted-foreground">({v.stock} left)</span>}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground">New order</h2>
        {lines.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm text-foreground">{l.title}</span>
            <Input className="w-20" type="number" min={1} max={100} value={l.quantity}
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
            <Input className="w-28" value={l.price} placeholder="Price"
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            <Button variant="ghost" size="sm" onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Input placeholder="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        <Input placeholder="WhatsApp number (e.g. 9632982245)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Shipping ₹" value={shipping} onChange={(e) => setShipping(e.target.value)} />
          <Input placeholder="Discount ₹" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={sendWhatsApp} onChange={(e) => setSendWhatsApp(e.target.checked)} />
          Send the checkout link on WhatsApp
        </label>
        <Button onClick={create} disabled={saving || !lines.length || !customerName || !phone}>
          {saving ? "Creating…" : "Create order"}
        </Button>

        {created && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium text-foreground">Order {created.order.name} · ₹{created.order.total}</p>
            <p className="text-muted-foreground">{created.order.items}</p>
            <a className="text-primary underline" href={created.order.checkoutUrl} target="_blank" rel="noreferrer">Payment link</a>
            {!created.whatsapp.sent && (
              <p className="mt-2 text-amber-600">WhatsApp not sent{created.whatsapp.error ? `: ${created.whatsapp.error}` : ""}. Copy the payment link instead.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
