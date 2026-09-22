import { addMinutes, HANDLING_BUFFER_MINUTES } from "@/lib/booking";

export type AvailableDay = {
  date: string;
  times: string[];
};

export type RankedRecommendation = {
  date: string;
  time: string;
  score: number;
  reason: string;
};

function occupiedImmediatelyBefore(date: string, time: string, occupiedSlots: Set<string>) {
  return occupiedSlots.has(`${date}T${addMinutes(time, -5)}`);
}

function occupiedImmediatelyAfter(
  date: string,
  time: string,
  occupiedMinutes: number,
  occupiedSlots: Set<string>,
) {
  return occupiedSlots.has(`${date}T${addMinutes(time, occupiedMinutes)}`);
}

function explanation(
  serviceName: string,
  durationMinutes: number,
  previousIsOccupied: boolean,
  nextIsOccupied: boolean,
) {
  const service = serviceName.toLowerCase();
  if (previousIsOccupied && nextIsOccupied) {
    return `Best fit for a ${durationMinutes}-minute ${service}. This time fills the space between two appointments without creating unused capacity.`;
  }
  if (previousIsOccupied) {
    return `Strong fit for a ${durationMinutes}-minute ${service}. It starts immediately after another appointment and keeps the working day compact.`;
  }
  if (nextIsOccupied) {
    return `Strong fit for a ${durationMinutes}-minute ${service}. It ends immediately before the next appointment and preserves a larger open block.`;
  }
  return `Best currently available fit for a ${durationMinutes}-minute ${service} while preserving the remaining schedule.`;
}

export function rankRecommendations({
  availableDays,
  occupiedSlots,
  durationMinutes,
  serviceName,
  limit,
  distinctDates,
  handlingMinutes = HANDLING_BUFFER_MINUTES,
}: {
  availableDays: AvailableDay[];
  occupiedSlots: Set<string>;
  durationMinutes: number;
  serviceName: string;
  limit: number;
  distinctDates: boolean;
  handlingMinutes?: number;
}) {
  const occupiedMinutes = durationMinutes + handlingMinutes;
  const ranked: RankedRecommendation[] = [];

  availableDays.forEach((day, dayIndex) => {
    day.times.forEach((time) => {
      const previousIsOccupied = occupiedImmediatelyBefore(day.date, time, occupiedSlots);
      const nextIsOccupied = occupiedImmediatelyAfter(day.date, time, occupiedMinutes, occupiedSlots);
      const [hour, minute] = time.split(":").map(Number);
      const minuteOfDay = hour * 60 + minute;
      const adjacencyScore =
        previousIsOccupied && nextIsOccupied ? 300 :
        previousIsOccupied ? 180 :
        nextIsOccupied ? 140 : 0;
      const score = adjacencyScore - dayIndex * 10 - minuteOfDay / 1440;
      ranked.push({
        date: day.date,
        time,
        score: Number(score.toFixed(4)),
        reason: explanation(serviceName, durationMinutes, previousIsOccupied, nextIsOccupied),
      });
    });
  });

  ranked.sort((left, right) => (
    right.score - left.score ||
    left.date.localeCompare(right.date) ||
    left.time.localeCompare(right.time)
  ));

  const selected: RankedRecommendation[] = [];
  const selectedDates = new Set<string>();
  for (const recommendation of ranked) {
    if (distinctDates && selectedDates.has(recommendation.date)) continue;
    selected.push(recommendation);
    selectedDates.add(recommendation.date);
    if (selected.length === limit) break;
  }
  return selected;
}
