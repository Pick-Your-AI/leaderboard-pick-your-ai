import { z } from "zod";

/**
 * Opaque identity after public artifact projection; never a navigation segment.
 * The existing browser caps the entire JSON response at 2,000,000 bytes. This
 * code-unit bound cannot exclude a string that fits that envelope. It is not an
 * upstream source-ID format or length claim. Preserve the projected spelling:
 * generic artifact projection already trims its IDs, and this reader never does.
 */
export const publicArtifactIdSchema = z
  .string()
  .min(1)
  .max(2_000_000)
  .refine((value) => value === value.trim());
