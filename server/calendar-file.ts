function calendarText(value: string): string {
  return value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/g, "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
}

function utc(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

function fold(line: string): string {
  let result = "";
  let bytes = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character);
    if (bytes + width > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += character;
    bytes += width;
  }
  return result;
}

export function calendarFile(event: { id: string; start: Date; end: Date; stamp: Date; revision: number; name: string; location: string | null }) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Daymark//Booking//EN", "BEGIN:VEVENT",
    `UID:${calendarText(event.id)}@daymark`, `DTSTAMP:${utc(event.stamp)}`, `DTSTART:${utc(event.start)}`,
    `DTEND:${utc(event.end)}`, `SEQUENCE:${event.revision}`, `SUMMARY:${calendarText(event.name)}`,
    ...(event.location ? [`LOCATION:${calendarText(event.location)}`] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].map(fold).join("\r\n");
}
