"use client";

// AG Grid (community) setup shared by the incidents table and the ledger: modules and the Almanac
// ledger theme. Every colour and face is a token from tokens.css, read through CSS variables, so
// the grids print like the rest of the page: pale sheet, blue-black ink, hairline rows, a firm rule
// under the head, square corners, no zebra.

import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const nightGridTheme = themeQuartz.withParams({
  browserColorScheme: "light",
  backgroundColor: "var(--color-sheet)",
  foregroundColor: "var(--color-ink)",
  textColor: "var(--color-ink)",
  subtleTextColor: "var(--color-muted)",
  chromeBackgroundColor: "var(--color-sheet)",
  headerBackgroundColor: "var(--color-sheet)",
  headerTextColor: "var(--color-muted)",
  headerFontFamily: "var(--font-body)",
  headerFontWeight: 500,
  headerFontSize: 14,
  headerRowBorder: { width: 2, color: "var(--color-rule-2)" },
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "transparent",
  borderColor: "var(--color-rule)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 0,
  rowBorder: { width: 1, color: "var(--color-rule)" },
  oddRowBackgroundColor: "var(--color-sheet)",
  rowHoverColor: "var(--color-paper-2)",
  selectedRowBackgroundColor: "var(--color-paper-2)",
  accentColor: "var(--color-accent)",
  iconColor: "var(--color-muted)",
  inputBorder: { width: 1, color: "var(--color-muted)" },
  inputFocusBorder: { width: 1, color: "var(--color-focus)" },
  menuBackgroundColor: "var(--color-sheet)",
  tooltipBackgroundColor: "var(--color-ink)",
  tooltipTextColor: "var(--color-sheet)",
  fontFamily: "var(--font-body)",
  fontSize: 15,
  cellHorizontalPadding: 12,
  spacing: 7,
});
