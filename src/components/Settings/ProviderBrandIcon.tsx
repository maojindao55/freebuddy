import type { CSSProperties } from "react";
import { Cable } from "lucide-react";
import { getModelBrand } from "../../services/providers/modelUtils";
import { normalizeProviderIconId, getProviderBrandIcon } from "./providerBrandIcons";
import freeBuddyLogo from "../../../assets/sidebar-logo.png";
import agnesLogo from "../../../assets/provider-icons/agnesai.webp";
import "./ProviderBrandIcon.css";

export interface ProviderBrandIconProps {
  nameOrId: string;
  lobeIconId?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  shape?: "square" | "circle";
  alt?: string;
}

export function ProviderBrandIcon({
  nameOrId,
  lobeIconId,
  size = 24,
  className = "",
  style,
  shape = "square",
  alt,
}: ProviderBrandIconProps) {
  const brand = getModelBrand(nameOrId);
  const explicitId = normalizeProviderIconId(lobeIconId ?? "");
  const inferredId = normalizeProviderIconId(brand.lobeIconId ?? nameOrId);
  const Icon = getProviderBrandIcon(explicitId) ?? getProviderBrandIcon(inferredId);
  const localImage = explicitId === "agnesai" || inferredId === "agnesai" ? agnesLogo
    : /freebuddy/i.test(nameOrId) ? freeBuddyLogo : undefined;
  const label = alt ?? ((brand.lobeIconId ? brand.name : nameOrId) || "Provider");
  const glyphSize = Math.round(size * 0.68);

  return (
    <span
      className={`provider-brand-icon provider-brand-icon-wrapper ${className}`}
      role="img"
      aria-label={label}
      title={label}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: shape === "circle" ? "50%" : Math.max(5, Math.round(size * 0.25)),
        ...style,
      }}
    >
      {localImage ? (
        <img src={localImage} width={glyphSize} height={glyphSize} alt="" aria-hidden="true" />
      ) : Icon ? (
        <Icon size={glyphSize} aria-hidden="true" />
      ) : (
        <Cable size={glyphSize} strokeWidth={1.7} aria-hidden="true" />
      )}
    </span>
  );
}
