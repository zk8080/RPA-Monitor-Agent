# Product

## Register

product

## Platform

web

## Users

Primary users are **developers and maintainers of ShadowBot (影刀) RPA flows** on a Windows workstation. They already know the apps, open source in a coding agent (Cursor / Claude Code), and use this surface between poll cycles—not as a full-time ops console.

Job to be done on any given screen: find an app, understand its flow structure, see related failures, and get to the local `xbot_robot` path quickly.

## Product Purpose

RPA Workbench is the **local observation and entry surface** for the RPA Monitor & Diagnosis Agent. The Agent still runs silently (poll / diagnose / report); the web UI makes local apps, queue failures, rpa-skill understand output (including call-graph flowcharts), and folder/path actions visible without flipping through `data/` or CLI.

Success looks like: open the browser, reach the right app, read a real flowchart, copy or open the project path, and continue work in the coding agent—with less friction than raw logs or the enterprise Yingdao dashboard alone.

## Positioning

**Local developer workbench for RPA flows—not a second operations dashboard.** Every screen should reinforce “understand and open source,” not “monitor fleet health.”

## Brand Personality

**Restrained · clear · useful.** Calm tool voice, short labels, no marketing flourish. Trust comes from accurate local data and readable structure, not visual drama.

## Anti-references

- AI-generated dashboards: neon dark themes, glow grids, hero metric cards, colored side-stripes, uppercase tracked kickers on every section
- Marketing SaaS landing patterns applied to an internal tool
- A clone of Yingdao’s enterprise ops dashboard (job success pie charts, task runbooks as the primary object)

## Design Principles

1. **Task over theater** — Layout and chrome serve “find app → read flow → open path”; decoration that doesn’t help that path goes away.
2. **Familiar tool grammar** — Side nav, tabs, lists, badges, and primary buttons should feel like Linear / ordinary desktop tools, not a campaign site.
3. **One primary action per surface** — e.g. copy path on detail; search on catalog; open app from “needs attention.” Secondary actions stay quiet.
4. **Show real structure** — Prefer rpa-skill call graphs and failure fingerprints over abstract KPI theater.
5. **Honest empty and loading states** — Say what is missing (no queue, no ShadowBot path, understand failed) and what to do next.

## Accessibility & Inclusion

Aim for readable contrast on body text (≥4.5:1), visible focus rings, and respect for `prefers-reduced-motion`. Keyboard: `/` focuses app search when available. No WCAG certification target yet; don’t rely on color alone for failure vs healthy state (pair badges with text).
