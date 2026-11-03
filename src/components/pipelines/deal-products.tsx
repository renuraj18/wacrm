"use client";

// Products attached to a deal (quantity × unit price). The parent deal
// form owns the line items and derives the deal value from them.

import { useEffect, useRef, useState } from "react";
import { ImageOff, Minus, Plus, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, formatPriceRange, type ProductListItem } from "@/lib/products/format";

export interface DealLineItem {
  product_id: string;
  title: string;
  image_url: string | null;
  quantity: number;
  unit_price: number;
}

export function lineItemsTotal(items: DealLineItem[]): number {
  return Math.round(items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0) * 100) / 100;
}

interface DealProductsProps {
  items: DealLineItem[];
  onChange: (items: DealLineItem[]) => void;
  currency: string;
  disabled?: boolean;
}

export function DealProducts({ items, onChange, currency, disabled }: DealProductsProps) {
  const t = useTranslations("Pipelines.form");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductListItem[]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/products?${new URLSearchParams({ q, limit: "8" })}`, {
        cache: "no-store",
      }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => ({})) : {};
      if (id === requestId.current) setResults((data.products as ProductListItem[]) ?? []);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Stale results from a previous query are hidden once the box is cleared.
  const visibleResults = query.trim() ? results : [];

  function add(p: ProductListItem) {
    const existing = items.find((i) => i.product_id === p.id);
    onChange(
      existing
        ? items.map((i) => (i.product_id === p.id ? { ...i, quantity: i.quantity + 1 } : i))
        : [
            ...items,
            {
              product_id: p.id,
              title: p.title,
              image_url: p.image_url,
              quantity: 1,
              unit_price: Number(p.price_min),
            },
          ],
    );
    setQuery("");
    setResults([]);
  }

  function update(productId: string, patch: Partial<DealLineItem>) {
    onChange(items.map((i) => (i.product_id === productId ? { ...i, ...patch } : i)));
  }

  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground">{t("products")}</Label>

      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li
              key={item.product_id}
              className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-1.5"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                {item.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${item.image_url}${item.image_url.includes("?") ? "&" : "?"}width=80`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={item.title}>
                {item.title}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={disabled || item.quantity <= 1}
                  onClick={() => update(item.product_id, { quantity: item.quantity - 1 })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  aria-label={t("decreaseQuantity")}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="w-6 text-center text-sm tabular-nums">{item.quantity}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => update(item.product_id, { quantity: item.quantity + 1 })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("increaseQuantity")}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                disabled={disabled}
                value={String(item.unit_price)}
                onChange={(e) =>
                  update(item.product_id, { unit_price: Math.max(0, Number.parseFloat(e.target.value) || 0) })
                }
                className="h-8 w-24 text-right"
                aria-label={t("unitPrice")}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(items.filter((i) => i.product_id !== item.product_id))}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                aria-label={t("removeProduct")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          <li className="flex justify-end pr-8 text-xs text-muted-foreground">
            {t("productsTotal", { total: formatMoney(lineItemsTotal(items), currency) })}
          </li>
        </ul>
      ) : null}

      {!disabled ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("addProduct")}
            className="pl-9"
          />
          {visibleResults.length > 0 ? (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
              {visibleResults.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => add(p)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate text-foreground">{p.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatPriceRange(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
