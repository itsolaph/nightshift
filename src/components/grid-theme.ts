"use client";

// AG Grid (community) setup shared by the incidents table and the ledger: modules and the dark
// night theme, built from the same colours as globals.css.

import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const nightGridTheme = themeQuartz.withParams({
  browserColorScheme: "dark",
  backgroundColor: "#0b1324",
  foregroundColor: "#e8edf7",
  chromeBackgroundColor: "#101a2f",
  headerBackgroundColor: "#101a2f",
  headerTextColor: "#8494b3",
  headerFontWeight: 600,
  borderColor: "#22314f",
  rowBorder: { color: "#18243d" },
  oddRowBackgroundColor: "#0d1628",
  rowHoverColor: "#15213a",
  selectedRowBackgroundColor: "rgba(245, 181, 68, 0.12)",
  accentColor: "#f5b544",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  fontSize: 13.5,
  wrapperBorderRadius: 12,
  spacing: 7,
});
