// Custom AG Studio theme: Nightshift's night palette (deep navy canvas, amber accent).

import { studioTheme } from "ag-studio";

const PALETTE = ["#f5b544", "#8fb3ff", "#46d39a", "#ff7a7a", "#b9a3ff", "#5fd4e8", "#ffd27a", "#f08bd0", "#9bd36a", "#c3cde0"];

const palette = Object.fromEntries(
  PALETTE.flatMap((color, i) => [
    [`chartPaletteFills${i + 1}Color`, color],
    [`chartPaletteStrokes${i + 1}Color`, color],
  ]),
);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

export const nightshiftStudioTheme = studioTheme.withParams({
  browserColorScheme: "dark",
  fontFamily: FONT,
  fontSize: 13,
  backgroundColor: "#0b1324",
  foregroundColor: "#e8edf7",
  textColor: "#e8edf7",
  subtleTextColor: "#8494b3",
  borderColor: "#22314f",
  accentColor: "#f5b544",
  iconColor: "#c3cde0",
  rowHoverColor: "#15213a",
  menuBackgroundColor: "#101a2f",
  tooltipBackgroundColor: "#15213a",
  tooltipTextColor: "#e8edf7",

  studioWrapperBackgroundColor: "#070d1a",
  studioCanvasBackgroundColor: "#070d1a",
  studioPanelContainerBackgroundColor: "#0b1324",
  studioWidgetBackgroundColor: "#101a2f",
  studioWidgetBorder: { width: 1, color: "#22314f" },
  studioWidgetBorderRadius: 12,
  studioWidgetTitleTextColor: "#e8edf7",
  studioWidgetSubtitleTextColor: "#8494b3",

  gridHeaderBackgroundColor: "#101a2f",
  gridHeaderTextColor: "#8494b3",
  gridOddRowBackgroundColor: "#0d1628",
  gridCellTextColor: "#e8edf7",
  gridRowBorder: { width: 1, color: "#18243d" },

  chartTextColor: "#e8edf7",
  chartSubtleTextColor: "#8494b3",
  chartAxisLineColor: "#31456b",
  chartGridLineColor: "#1a2846",
  chartTooltipBackgroundColor: "#15213a",
  chartTooltipTextColor: "#e8edf7",
  ...palette,
});
