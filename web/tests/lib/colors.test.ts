import { describe, it, expect } from "vitest";
import { createExportTheme, type DiagramTheme } from "../../lib/colors";
import { LIGHT_DIAGRAM_THEME, DARK_DIAGRAM_THEME } from "../../lib/theme";

describe("Color conversion for Satori compatibility", () => {
  describe("createExportTheme", () => {
    it("should convert LIGHT_DIAGRAM_THEME to RGB format", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      expect(exported.background).toMatch(/^rgb\(/);
      expect(exported.rowEven).toMatch(/^rgb\(/);
      expect(exported.rowOdd).toMatch(/^rgb\(/);
      expect(exported.rulerTick).toMatch(/^rgb\(/);
      expect(exported.rulerLabel).toMatch(/^rgb\(/);
      expect(exported.accent).toMatch(/^rgb\(/);
      expect(exported.fieldStroke).toMatch(/^rgb\(/);
      expect(exported.fieldLabel).toMatch(/^rgb\(/);
      expect(exported.fieldSublabel).toMatch(/^rgb\(/);
      expect(exported.fieldContinuation).toMatch(/^rgb\(/);
    });

    it("should convert DARK_DIAGRAM_THEME to RGB format", () => {
      const exported = createExportTheme(DARK_DIAGRAM_THEME);

      expect(exported.background).toMatch(/^rgb\(/);
      expect(exported.accent).toMatch(/^rgb\(/);
    });

    it("should convert fieldPalette colors to RGB", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      Object.entries(exported.fieldPalette).forEach(([color, value]) => {
        expect(value).toMatch(/^rgb\(/, `palette color ${color} should be rgb format`);
      });
    });

    it("should preserve opacity values from original theme", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      expect(exported.fieldFillOpacity).toBe(LIGHT_DIAGRAM_THEME.fieldFillOpacity);
      expect(exported.rulerMinorOpacity).toBe(LIGHT_DIAGRAM_THEME.rulerMinorOpacity);
      expect(exported.subfieldBackgroundOpacity).toBe(
        LIGHT_DIAGRAM_THEME.subfieldBackgroundOpacity,
      );
    });

    it("should not contain any OKLch colors (not compatible with Satori)", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      const allValues = [
        exported.background,
        exported.rowEven,
        exported.rowOdd,
        exported.rulerTick,
        exported.rulerLabel,
        exported.accent,
        exported.fieldStroke,
        exported.fieldLabel,
        exported.fieldSublabel,
        exported.fieldContinuation,
        ...Object.values(exported.fieldPalette),
      ];

      allValues.forEach((value) => {
        expect(value).not.toMatch(/oklch\(/);
      });
    });
  });

  describe("RGB color validation", () => {
    it("should produce valid RGB values (0-255)", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      const rgbRegex = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

      const testRgb = (color: string, colorName: string) => {
        const match = color.match(rgbRegex);
        expect(match).toBeTruthy();
        if (match) {
          const [, r, g, b] = match;
          expect(Number(r)).toBeGreaterThanOrEqual(0);
          expect(Number(r)).toBeLessThanOrEqual(255);
          expect(Number(g)).toBeGreaterThanOrEqual(0);
          expect(Number(g)).toBeLessThanOrEqual(255);
          expect(Number(b)).toBeGreaterThanOrEqual(0);
          expect(Number(b)).toBeLessThanOrEqual(255);
        }
      };

      testRgb(exported.background, "background");
      testRgb(exported.accent, "accent");
      testRgb(exported.fieldLabel, "fieldLabel");
    });
  });
});
