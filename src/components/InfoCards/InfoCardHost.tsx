import { useEffect } from "react";

import { useInfoCardStore } from "@/store/infoCardStore";
import { FeedCard } from "../Feeds/FeedCard";
import { InfoDataCard } from "./InfoDataCard";

export function InfoCardHost() {
  const cards = useInfoCardStore((state) => state.cards);
  const loaded = useInfoCardStore((state) => state.loaded);
  const load = useInfoCardStore((state) => state.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [load, loaded]);

  useEffect(() => {
    return window.freebuddy?.infoCards.onChanged(() => void load());
  }, [load]);

  return (
    <>
      {cards
        .filter((card) => card.enabled)
        .sort((a, b) => a.order - b.order)
        .map((card) =>
          card.type === "rss" ? (
            <FeedCard key={card.id} title={card.title} />
          ) : (
            <InfoDataCard key={card.id} card={card} />
          )
        )}
    </>
  );
}
