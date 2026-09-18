import React, { useState, useEffect } from "react";
import { getModelBrand } from "../../services/providers/modelUtils";

export interface ProviderBrandIconProps {
  nameOrId: string;
  lobeIconId?: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  shape?: "square" | "circle";
  alt?: string;
}

export const ProviderBrandIcon: React.FC<ProviderBrandIconProps> = ({
  nameOrId,
  lobeIconId,
  size = 24,
  className = "",
  style,
  shape = "square",
  alt,
}) => {
  const brand = getModelBrand(nameOrId);
  const iconId = lobeIconId || brand.lobeIconId;

  // Track error state for URL fallbacks: 0 = try jsdelivr, 1 = try npmmirror, 2 = fallback badge
  const [loadStage, setLoadStage] = useState<number>(iconId ? 0 : 2);

  useEffect(() => {
    setLoadStage(iconId ? 0 : 2);
  }, [iconId]);

  const borderRadius = shape === "circle" ? "50%" : Math.max(4, Math.round(size * 0.22));

  if (iconId && loadStage < 2) {
    const src =
      loadStage === 0
        ? `https://fastly.jsdelivr.net/npm/@lobehub/icons-static-avatar@latest/avatars/${iconId}.webp`
        : `https://registry.npmmirror.com/@lobehub/icons-static-avatar/latest/files/avatars/${iconId}.webp`;

    return (
      <div
        className={`provider-brand-icon-wrapper ${className}`}
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          borderRadius,
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          border: "none",
          outline: "none",
          boxShadow: "none",
          ...style,
        }}
        title={brand.name}
      >
        <img
          src={src}
          alt={alt || brand.name}
          width={size}
          height={size}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius,
            display: "block",
            border: "none",
            outline: "none",
          }}
          onError={() => {
            setLoadStage((prev) => prev + 1);
          }}
        />
      </div>
    );
  }

  // Fallback styled badge
  const fontSize = Math.max(9, Math.round(size * 0.4));
  return (
    <div
      className={`provider-brand-badge-fallback ${className}`}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius,
        backgroundColor: brand.bg,
        color: brand.color,
        border: "none",
        outline: "none",
        boxShadow: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize,
        flexShrink: 0,
        userSelect: "none",
        ...style,
      }}
      title={brand.name}
    >
      {brand.badge}
    </div>
  );
};
