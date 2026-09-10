// Requires a SUBJECT word (what the live data tracks) AND an AVAILABILITY
// word to both appear before treating a question as needing live/current
// data. A plain OR-list of generic words (e.g. "book", "available",
// "current") was too eager: "Do I need to pay a deposit at booking?" and
// even an unrelated cross-site question both contain "booking"/"book" and
// got hijacked into the room-availability answer, overriding a much
// better knowledge-base match (or masking that nothing matched at all).
const SUBJECT_WORDS = ["room", "rooms", "slot", "slots", "appointment", "appointments", "table", "tables"];
const AVAILABILITY_WORDS = ["available", "availability", "avail", "vacancy", "vacant", "left", "open", "occupied", "booked up", "free"];

export function needsLiveData(message: string): boolean {
  const lower = message.toLowerCase();
  const hasSubject = SUBJECT_WORDS.some((w) => lower.includes(w));
  const hasAvailability = AVAILABILITY_WORDS.some((w) => lower.includes(w));
  return hasSubject && hasAvailability;
}

// For a self-service customer (customApiUrl), we can't hardcode SUBJECT_WORDS
// -- their "subject" is whatever they call their own inventory ("haircut",
// "bike", "table"), which we only know at runtime from their own data. So
// for that case an availability word has to work ALONE as the gate, with no
// paired subject word to keep it honest. That rules out "open"/"left"/"free"
// from the shared list above -- each has an everyday meaning with nothing to
// do with inventory ("is Sunday open", "who's left in line", "feel free to
// ask") that a bare substring match would wrongly catch. Only words that are
// essentially unambiguous on their own are safe here.
const STANDALONE_AVAILABILITY_WORDS = ["available", "availability", "avail", "vacancy", "vacant", "occupied", "booked up"];

export function hasAvailabilityWord(message: string): boolean {
  const lower = message.toLowerCase();
  return STANDALONE_AVAILABILITY_WORDS.some((w) => lower.includes(w));
}
