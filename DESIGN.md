---
name: RPA Workbench
description: Local developer workbench for ShadowBot RPA apps, flow graphs, and failure context
colors:
  bg: "#f4f5f7"
  bg-elevated: "#fafbfc"
  surface: "#ffffff"
  surface-2: "#f1f3f5"
  rail: "#0f172a"
  text: "#0f172a"
  text-2: "#475569"
  text-3: "#64748b"
  primary: "#2a6de7"
  primary-hover: "#1f5bc9"
  ok: "#047857"
  warn: "#b45309"
  danger: "#b91c1c"
typography:
  # Fixed rem scale (~1.15). CSS tokens: --text-xs … --text-page
  caption:
    fontSize: "11px" # --text-xs: badge / rank / kickers
  secondary:
    fontSize: "12px" # --text-sm: meta / mono / item-sub
  ui:
    fontSize: "13px" # --text-ui: buttons, tabs
  body:
    fontFamily: "system-ui, Segoe UI, PingFang SC, Microsoft YaHei UI, sans-serif"
    fontSize: "14px" # --text-body
    fontWeight: 400
    lineHeight: 1.5
  listTitle:
    fontSize: "15px" # --text-list: card/list primary row (always ≥ body)
    fontWeight: 600
  section:
    fontSize: "16px" # --text-section: panel h2 / report h2
    fontWeight: 600
  subhead:
    fontSize: "18px" # --text-subhead: brief / content title
    fontWeight: 600
  title:
    fontFamily: "system-ui, Segoe UI, PingFang SC, Microsoft YaHei UI, sans-serif"
    fontSize: "28px" # --text-page
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  mono:
    fontFamily: "ui-monospace, Cascadia Code, SF Mono, Consolas, monospace"
    fontSize: "12px" # default mono; list mono titles use listTitle size
    fontWeight: 400
    lineHeight: 1.45
rounded:
  tag: "4px"
  control: "6px"
  card: "6px"
  soft: "8px"
---

# Design System: RPA Workbench

## Overview

Calm slate tool: cool gray canvas + slate rail + brand-blue accent (`#2a6de7`). Product tool grammar (Linear-like), not warm paper atelier or neon AI console.

## Colors

Cool near-white neutrals; slate rail; restrained brand blue (`#2a6de7`) for primary/selection/focus only. Semantic colors only on status.

## Typography

System UI stack (Segoe UI / San Francisco / PingFang / YaHei) + system mono. No webfont load.

**Hierarchy ladder (must not invert):** caption 11 → secondary 12 → body 14 → **list/card title 15** → **panel section 16** → subhead 18 → page 28. Weight 600 on titles; secondary copy stays 400 + muted color. Mono face on list titles keeps list size (never 12px title under 14px body). Panel `h2` is a real section title (not uppercase caption).

## Elevation

Hairline borders + soft dual shadow. Panels float on paper. Graph on elevated board.

## Components

Dark sticky rail, centered 1080px canvas, squared controls (6px) vs tighter tags (4px), metric strip, always-visible list actions, graph hero.

## Do's and Don'ts

Do keep rail + light canvas and restrained accent. Don't use warm cream paper, purple glow washes, side-stripes, hero KPI walls, or Yingdao ops clones.
