import {
  Axis3d,
  Box,
  Circle,
  Cone,
  Cylinder,
  Download,
  FilePlus,
  Flashlight,
  FolderOpen,
  Globe,
  Hexagon,
  Image,
  Info,
  Keyboard,
  Lightbulb,
  LogIn,
  LogOut,
  Move3d,
  RectangleHorizontal,
  Redo2,
  Save,
  Search,
  Server,
  Settings,
  Square,
  Sun,
  Torus,
  Triangle,
  Undo2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { LightKind, ObjectType } from '../../core/doc/schema';

/**
 * Icônes désignées par leur nom dans le catalogue des menus (src/tools/menus.ts).
 * Un nom inconnu n'affiche simplement aucune icône.
 */
const BY_NAME: Record<string, LucideIcon> = {
  Box,
  Square,
  Circle,
  Globe,
  Hexagon,
  Cylinder,
  Cone,
  Torus,
  Lightbulb,
  Sun,
  Flashlight,
  RectangleHorizontal,
  Video,
  Move3d,
  FilePlus,
  FolderOpen,
  Save,
  Download,
  Upload,
  Undo2,
  Redo2,
  Search,
  Settings,
  Image,
  Server,
  LogIn,
  LogOut,
  Keyboard,
  Info,
};

export function iconByName(name: string | undefined): LucideIcon | null {
  return name ? (BY_NAME[name] ?? null) : null;
}

const LIGHT_ICONS: Record<LightKind, LucideIcon> = {
  point: Lightbulb,
  sun: Sun,
  spot: Flashlight,
  area: RectangleHorizontal,
};

/** Icône d'un objet selon son type (et le genre de lumière). */
export function objectIcon(type: ObjectType, lightKind?: LightKind | null): LucideIcon {
  switch (type) {
    case 'mesh':
      return Triangle;
    case 'light':
      return LIGHT_ICONS[lightKind ?? 'point'] ?? Lightbulb;
    case 'camera':
      return Video;
    default:
      return Axis3d;
  }
}
