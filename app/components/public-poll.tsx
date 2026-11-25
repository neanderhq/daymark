"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button, Card, EmptyState, ErrorField, Input, PageHeader } from "./ui";
import { formatInstant } from "../../server/timezone";

type PublicPollOption = {
  id: string;
  startUtc: string;
};

type PublicPollVote = {
  name: string;
  optionIds: string[];
};

type PublicPollData = {
  title: string;
  description: string | null;
  durationMinutes: number;
  showVotes: boolean;
  status: "open" | "closed";
  options: PublicPollOption[];
  votes: PublicPollVote[];
  booking: { startUtc: string; status: "active" | "cancelled" } | null;
};

const timezones = Intl.supportedValuesOf("timeZone");
const timezoneOptions = [...timezones, ...(timezones.includes("UTC") ? [] : ["UTC"])];

function isValidTimezone(value: string): boolean {
  if (value.length > 100) return false;
  try {
    const canonicalTimezone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return canonicalTimezone === "UTC" || timezones.includes(canonicalTimezone);
  } catch {
    return false;
  }
}

function formatInTimezone(iso: string, timezone: string): string {
  return formatInstant(new Date(iso), timezone);
}

async function readError(response: Response, fallback: string): Promise<string> {
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  return typeof result.error === "string" && result.error ? result.error : fallback;
}

export function PublicPoll({ token }: { token: string }) {
  const [poll, setPoll] = useState<PublicPollData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [timezone, setTimezone] = useState("UTC");
  const [timezoneText, setTimezoneText] = useState("UTC");
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [voteError, setVoteError] = useState("");
  const [votePending, setVotePending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTimezone && isValidTimezone(detectedTimezone)) {
      setTimezone(detectedTimezone);
      setTimezoneText(detectedTimezone);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    setNotFound(false);

    async function loadPoll() {
      try {
        const response = await fetch(`/api/public/polls/${encodeURIComponent(token)}`, {
          signal: controller.signal,
        });
        if (response.status === 404) {
          setNotFound(true);
          setPoll(null);
          return;
        }
        if (!response.ok) throw new Error(await readError(response, "This poll couldn’t be loaded."));
        const result = (await response.json()) as PublicPollData;
        if (!Array.isArray(result.options) || !Array.isArray(result.votes)) {
          throw new Error("This poll couldn’t be loaded.");
        }
        setPoll(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error && error.message
          ? error.message
          : "This poll couldn’t be loaded. Check your connection and try again.");
      }
    }

    void loadPoll();
    return () => controller.abort();
  }, [retryKey, token]);

  function updateTimezone(value: string) {
    setTimezoneText(value);
    if (isValidTimezone(value)) setTimezone(value);
  }

  function restoreTimezoneOnBlur() {
    if (!isValidTimezone(timezoneText)) setTimezoneText(timezone);
  }

  function toggleOption(optionId: string) {
    setSelectedOptionIds((current) => current.includes(optionId)
      ? current.filter((selectedId) => selectedId !== optionId)
      : [...current, optionId]);
    setVoteError("");
  }

  async function submitVote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!poll || poll.status !== "open") return;

    setVotePending(true);
    setVoteError("");
    try {
      const response = await fetch(`/api/public/polls/${encodeURIComponent(token)}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, optionIds: selectedOptionIds }),
      });
      if (!response.ok) {
        setVoteError(await readError(response, "Your vote couldn’t be submitted. Please try again."));
        return;
      }
      setSubmitted(true);
      setRetryKey((current) => current + 1);
    } catch {
      setVoteError("Your vote couldn’t be submitted. Check your connection and try again.");
    } finally {
      setVotePending(false);
    }
  }

  const isOpen = poll?.status === "open";
  const isClosed = poll?.status === "closed";

  return (
    <main className="app-shell">
      <div className="dashboard-content scheduling-content">
        {poll ? (
          <>
            <PageHeader eyebrow="Meeting poll" title={poll.title} description={poll.description ?? undefined} />
            <div className="poll-detail-main">
              {submitted && (
                <Card className="poll-summary-card">
                  <p className="poll-success-message" role="status">Your vote has been submitted. Thanks for helping find a time.</p>
                </Card>
              )}

              {isClosed && (
                <Card className="poll-final-card" aria-labelledby="poll-final-heading">
                  <p className="eyebrow">Voting is closed</p>
                  <h2 id="poll-final-heading">{poll.booking?.status === "cancelled" ? "Meeting cancelled" : "Final booked time"}</h2>
                  {poll.booking ? (
                    <p className="poll-final-time">{formatInTimezone(poll.booking.startUtc, timezone)}</p>
                  ) : (
                    <p className="field-hint">Voting for this poll has closed.</p>
                  )}
                  <p className="field-hint">Times shown in {timezone}.</p>
                </Card>
              )}

              <Card className="poll-results-card">
                <div className="poll-section-heading">
                  <h2>Proposed times</h2>
                  <p>{poll.durationMinutes} minutes · Times in {timezone}</p>
                </div>
                {isOpen && !submitted ? (
                  <fieldset className="poll-time-picker">
                    <legend>Select every time that works for you</legend>
                    <ul className="poll-chosen-times">
                      {poll.options.map((option) => {
                    const voters = poll.showVotes
                      ? poll.votes.filter((vote) => vote.optionIds.includes(option.id))
                      : [];
                    const isBookedTime = poll.booking?.status === "active" && poll.booking.startUtc === option.startUtc;
                    return (
                      <li className="result-row" key={option.id}>
                        {!submitted && (
                          <label className="booking-option" htmlFor={`poll-option-${option.id}`}>
                            <input
                              id={`poll-option-${option.id}`}
                              type="checkbox"
                              aria-label={`Select ${formatInTimezone(option.startUtc, timezone)}`}
                              checked={selectedOptionIds.includes(option.id)}
                              onChange={() => toggleOption(option.id)}
                            />
                          </label>
                        )}
                        <div className="result-row-main">
                          <time dateTime={option.startUtc}>{formatInTimezone(option.startUtc, timezone)}</time>
                          {isBookedTime && <span className="poll-label poll-label-top">Booked</span>}
                          {poll.showVotes && (
                            <>
                              <p className="result-vote-count">{voters.length} {voters.length === 1 ? "vote" : "votes"}</p>
                              {voters.length > 0 ? (
                                <ul className="poll-voter-list">
                                  {voters.map((voter, voterIndex) => (
                                    <li key={`${option.id}-${voterIndex}`}><span>{voter.name}</span></li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="field-hint poll-voter-empty">No votes yet.</p>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                      })}
                    </ul>
                  </fieldset>
                ) : (
                  <ul className="poll-chosen-times">
                    {poll.options.map((option) => {
                      const voters = poll.showVotes
                        ? poll.votes.filter((vote) => vote.optionIds.includes(option.id))
                        : [];
                      const isBookedTime = poll.booking?.status === "active" && poll.booking.startUtc === option.startUtc;
                      return (
                        <li className="result-row" key={option.id}>
                          <div className="result-row-main">
                            <time dateTime={option.startUtc}>{formatInTimezone(option.startUtc, timezone)}</time>
                            {isBookedTime && <span className="poll-label poll-label-top">Booked</span>}
                            {poll.showVotes && (
                              <>
                                <p className="result-vote-count">{voters.length} {voters.length === 1 ? "vote" : "votes"}</p>
                                {voters.length > 0 ? (
                                  <ul className="poll-voter-list">
                                    {voters.map((voter, voterIndex) => (
                                      <li key={`${option.id}-${voterIndex}`}><span>{voter.name}</span></li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="field-hint poll-voter-empty">No votes yet.</p>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card className="poll-booking-card">
                <Input
                  id="poll-timezone"
                  label="Time zone"
                  list="poll-timezone-options"
                  value={timezoneText}
                  onChange={(event) => updateTimezone(event.target.value)}
                  onBlur={restoreTimezoneOnBlur}
                  autoComplete="off"
                  hint="Choose an IANA time zone; all poll times use this zone."
                />
                <datalist id="poll-timezone-options">
                  {timezoneOptions.map((item) => <option key={item} value={item} />)}
                </datalist>

                {isOpen && !submitted && (
                  <form className="form-stack" onSubmit={submitVote}>
                    <Input
                      id="poll-invitee-name"
                      label="Your name"
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <Input
                      id="poll-invitee-email"
                      label="Email address"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                    {voteError && <ErrorField>{voteError}</ErrorField>}
                    <Button type="submit" disabled={votePending || selectedOptionIds.length === 0}>
                      {votePending ? "Submitting…" : "Submit vote"}
                    </Button>
                  </form>
                )}
                {isClosed && <p className="field-hint">Voting is closed. You can no longer submit a vote.</p>}
                {isOpen && submitted && <p className="field-hint">Your vote is recorded; voting controls are hidden.</p>}
              </Card>
            </div>
          </>
        ) : notFound ? (
          <>
            <PageHeader eyebrow="Meeting poll" title="This poll link isn’t valid" description="Check that you copied the whole link." />
            <Card className="poll-summary-card">
              <EmptyState title="Poll not found" description="This poll may have been removed or the link may be incomplete." />
            </Card>
          </>
        ) : loadError ? (
          <>
            <PageHeader eyebrow="Meeting poll" title="Poll unavailable" description="We couldn’t load this poll right now." />
            <Card className="poll-summary-card">
              <ErrorField>{loadError}</ErrorField>
              <Button type="button" variant="secondary" onClick={() => setRetryKey((current) => current + 1)}>
                Try again
              </Button>
            </Card>
          </>
        ) : (
          <p className="field-hint" role="status" aria-live="polite">Loading poll…</p>
        )}
      </div>
    </main>
  );
}
