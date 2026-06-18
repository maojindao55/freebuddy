---
version: alpha
name: FreeBuddy
description: A clean, high-tech, and vibrant visual system for the desktop CLI agent workspace.
colors:
  primary: "#0f172a"
  secondary: "#475569"
  tertiary: "#94a3b8"
  brand: "#10b981"
  brand-gradient-start: "#10b981"
  brand-gradient-end: "#06b6d4"
  danger: "#e11d48"
  warning: "#f59e0b"
  neutral-light: "#f8fafc"
  neutral-dark: "#0b1329"
typography:
  interface:
    fontFamily: Plus Jakarta Sans, Outfit, system-ui
    fontSize: 13px
  heading:
    fontFamily: Outfit, sans-serif
    fontSize: 46px
    fontWeight: 800
  monospace:
    fontFamily: JetBrains Mono, monospace
    fontSize: 12px
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  composer:
    backgroundColor: "{colors.neutral-light}"
    rounded: "{rounded.xl}"
    padding: 20px
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
  badge-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
  badge-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.primary}"
  workspace-panel:
    backgroundColor: "{colors.neutral-dark}"
    rounded: "{rounded.lg}"
  header-gradient:
    backgroundColor: "{colors.brand-gradient-start}"
    textColor: "{colors.primary}"
  button-gradient:
    backgroundColor: "{colors.brand-gradient-end}"
    textColor: "{colors.primary}"
---

## Overview

FreeBuddy's visual identity focuses on **High-Contrast Telemetry** and **Tactile Developer Focus**. The interface uses clean radial backgrounds, subtle card highlights, and distinct monospace blocks to present CLI agent activities with clarity and precision.

## Colors

* **Brand Teal (#00c29a):** The primary color used for indicators, progress states, active links, and brand gradients.
* **Slate Primary (#0f172a):** Ink text headlines in light mode, text content base.
* **Neutral Dark (#0b0f19):** Foundation background for dark mode.
* **Neutral Light (#f8fafc):** Foundation background for light mode.

## Typography

The interface balances readable grotesque titles with high-legibility interface copy and developer-first terminal structures:

* **Outfit (Heading):** Bold, heavy-weighted titles that look crisp on modern displays.
* **Plus Jakarta Sans (Interface):** Sleek, clean body sans-serif.
* **JetBrains Mono (Console):** High readability monospace font for command logs, JSON outputs, and path strings.

## Layout & Spacing

* Sidebar layout is constrained to `272px` with a sidebar footer.
* Inner padding scales between `12px` and `24px` to keep elements separated yet cohesive.

## Elevation & Depth

* Active card items use high-depth soft shadows (`--fb-shadow-lg`) and thin outline borders (`rgba(148, 163, 184, 0.24)`) to separate content planes.
