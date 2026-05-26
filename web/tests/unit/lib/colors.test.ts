import { describe, it, expect } from "vitest";
import { createExportTheme } from "@/lib/colors";
import { LIGHT_DIAGRAM_THEME, DARK_DIAGRAM_THEME } from "@/lib/theme";

describe("Color conversion for Satori compatibility", () => {
  describe("createExportTheme", () => {
    it("should convert LIGHT_DIAGRAM_THEME to hex format", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      expect(exported.background).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.rowEven).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.rowOdd).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.rulerTick).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.rulerLabel).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.accent).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.fieldStroke).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.fieldLabel).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.fieldSublabel).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.fieldContinuation).toMatch(/^#[0-9A-F]{6}$/);
    });

    it("should convert DARK_DIAGRAM_THEME to hex format", () => {
      const exported = createExportTheme(DARK_DIAGRAM_THEME);

      expect(exported.background).toMatch(/^#[0-9A-F]{6}$/);
      expect(exported.accent).toMatch(/^#[0-9A-F]{6}$/);
    });

    it("should convert fieldPalette colors to hex", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      Object.entries(exported.fieldPalette).forEach(([, value]) => {
        expect(value).toMatch(/^#[0-9A-F]{6}$/);
      });
    });

    it("should preserve opacity values from original theme", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      expect(exported.fieldFillOpacity).toBe(
        LIGHT_DIAGRAM_THEME.fieldFillOpacity,
      );
      expect(exported.rulerMinorOpacity).toBe(
        LIGHT_DIAGRAM_THEME.rulerMinorOpacity,
      );
      expect(exported.subfieldBackgroundOpacity).toBe(
        LIGHT_DIAGRAM_THEME.subfieldBackgroundOpacity,
      );
    });

    it("should not contain any OKLch or rgb() colors (Satori only supports hex)", () => {
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
        expect(value).not.toMatch(/^rgb\(/);
      });
    });
  });

  describe("Hex color validation", () => {
    it("should produce valid hex color values", () => {
      const exported = createExportTheme(LIGHT_DIAGRAM_THEME);

      const hexRegex = /^#[0-9A-F]{6}$/;

      const testHex = (color: string) => {
        expect(color).toMatch(hexRegex);
      };

      testHex(exported.background);
      testHex(exported.accent);
      testHex(exported.fieldLabel);
    });
  });
});
