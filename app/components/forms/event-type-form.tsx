"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { CopyButton } from "../copy-button";
import { Button, EmptyState, ErrorField, Input } from "../ui";

type EventRecord = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  location: string | null;
  slug: string;
  active: boolean;
};

type QuestionRecord = {
  id: string;
  label: string;
  questionType: "short_text" | "long_text" | "single_choice";
  options: string[] | null;
  required: boolean;
  position: number;
};

type DraftQuestion = {
  label: string;
  questionType: QuestionRecord["questionType"];
  optionsText: string;
  required: boolean;
};

const standardDurations = [15, 30, 45, 60];
const emptyDraft: DraftQuestion = { label: "", questionType: "short_text", optionsText: "", required: false };

async function readResult(response: Response) {
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  return result.error || "Your changes couldn’t be saved. Please try again.";
}

export function EventTypeForm({ event, username, questions, mode = "default" }: {
  event: EventRecord;
  username: string | null;
  questions: QuestionRecord[];
  mode?: "default" | "new" | "secondary";
}) {
  const router = useRouter();
  const [savedPath, setSavedPath] = useState(username && event.id ? `/${username}/${event.slug}` : "");
  const [currentEvent, setCurrentEvent] = useState(event);
  const [currentUsername, setCurrentUsername] = useState(username);
  const [durationChoice, setDurationChoice] = useState(
    standardDurations.includes(event.durationMinutes) ? String(event.durationMinutes) : "custom",
  );
  const [customDuration, setCustomDuration] = useState(String(standardDurations.includes(event.durationMinutes) ? 20 : event.durationMinutes));
  const [eventError, setEventError] = useState("");
  const [slugError, setSlugError] = useState("");
  const [eventSaved, setEventSaved] = useState(false);
  const [eventPending, setEventPending] = useState(false);
  const [currentQuestions, setCurrentQuestions] = useState(questions);
  const [draft, setDraft] = useState(emptyDraft);
  const [questionError, setQuestionError] = useState("");
  const [questionPending, setQuestionPending] = useState(false);
  const [questionPendingAction, setQuestionPendingAction] = useState<"add" | "save" | "delete" | "reorder" | null>(null);
  const [questionPendingId, setQuestionPendingId] = useState<string | null>(null);
  const [questionSaved, setQuestionSaved] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);

  async function saveEvent(event_: FormEvent<HTMLFormElement>) {
    event_.preventDefault();
    setEventPending(true);
    setEventError("");
    setSlugError("");
    setEventSaved(false);
    try {
      const response = await fetch("/api/event-type", {
        method: mode === "new" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: currentEvent.name,
          description: currentEvent.description,
          durationMinutes: durationChoice === "custom" ? Number(customDuration) : Number(durationChoice),
          location: currentEvent.location,
          slug: currentEvent.slug,
          active: currentEvent.active,
          ...(mode === "default" ? { username: currentUsername } : mode === "secondary" ? { id: event.id } : {}),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string; field?: string };
        const message = result.error || "Your changes couldn’t be saved. Please try again.";
        if (result.field === "slug") {
          setSlugError(message);
          document.getElementById("event-slug")?.focus();
        } else setEventError(message);
        return;
      }
      const saved = (await response.json()) as EventRecord & { username?: string | null };
      if (mode === "new") {
        router.replace(`/dashboard/event-type?page=${saved.id}`);
        router.refresh();
        return;
      }
      const savedUsername = saved.username ?? username;
      setSavedPath(savedUsername ? `/${savedUsername}/${saved.slug}` : "");
      setCurrentEvent(saved);
      setCurrentUsername(savedUsername);
      setEventSaved(true);
      router.refresh();
    } catch {
      setEventError("Your changes couldn’t be saved. Check your connection and try again.");
    } finally {
      setEventPending(false);
    }
  }

  async function addQuestion(event_: FormEvent<HTMLFormElement>) {
    event_.preventDefault();
    setQuestionPending(true);
    setQuestionPendingAction("add");
    setQuestionPendingId(null);
    setQuestionError("");
    setQuestionSaved("");
    try {
      const response = await fetch("/api/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: draft.label,
          questionType: draft.questionType,
          options: draft.questionType === "single_choice" ? draft.optionsText.split("\n").map((option) => option.trim()) : null,
          required: draft.required,
        }),
      });
      if (!response.ok) {
        setQuestionError(await readResult(response));
        return;
      }
      const question = (await response.json()) as QuestionRecord;
      setCurrentQuestions((current) => [...current, question]);
      setDraft(emptyDraft);
      setQuestionSaved("Question added.");
    } catch {
      setQuestionError("Your question couldn’t be saved. Check your connection and try again.");
    } finally {
      setQuestionPending(false);
      setQuestionPendingAction(null);
      setQuestionPendingId(null);
    }
  }

  async function updateQuestion(question: QuestionRecord) {
    setQuestionPending(true);
    setQuestionPendingAction("save");
    setQuestionPendingId(question.id);
    setQuestionError("");
    setQuestionSaved("");
    try {
      const response = await fetch(`/api/questions/${question.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: question.label,
          questionType: question.questionType,
          options: question.questionType === "single_choice" ? question.options ?? [] : null,
          required: question.required,
        }),
      });
      if (!response.ok) {
        setQuestionError(await readResult(response));
        return;
      }
      const saved = (await response.json()) as QuestionRecord;
      setCurrentQuestions((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      setQuestionSaved("Question saved.");
    } catch {
      setQuestionError("Your question couldn’t be saved. Check your connection and try again.");
    } finally {
      setQuestionPending(false);
      setQuestionPendingAction(null);
      setQuestionPendingId(null);
    }
  }

  async function deleteQuestion(id: string) {
    setQuestionPending(true);
    setQuestionPendingAction("delete");
    setQuestionPendingId(id);
    setQuestionError("");
    setQuestionSaved("");
    try {
      const response = await fetch(`/api/questions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setQuestionError(await readResult(response));
        return;
      }
      setCurrentQuestions((current) => current.filter((question) => question.id !== id));
      setQuestionSaved("Question deleted.");
    } catch {
      setQuestionError("Your question couldn’t be deleted. Check your connection and try again.");
    } finally {
      setQuestionPending(false);
      setQuestionPendingAction(null);
      setQuestionPendingId(null);
    }
  }

  async function moveQuestion(index: number, direction: -1 | 1) {
    if (questionPending) return;
    const target = index + direction;
    if (target < 0 || target >= currentQuestions.length) return;
    const reordered = [...currentQuestions];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setQuestionPending(true);
    setQuestionPendingAction("reorder");
    setQuestionPendingId(currentQuestions[index].id);
    setQuestionError("");
    setQuestionSaved("");
    try {
      const response = await fetch("/api/questions/reorder", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionIds: reordered.map((question) => question.id) }),
      });
      if (!response.ok) {
        setQuestionError(await readResult(response));
        return;
      }
      setCurrentQuestions(reordered.map((question, position) => ({ ...question, position: position + 1 })));
      setQuestionSaved("Question order updated.");
    } catch {
      setQuestionError("Your question order couldn’t be saved. Check your connection and try again.");
    } finally {
      setQuestionPending(false);
      setQuestionPendingAction(null);
      setQuestionPendingId(null);
    }
  }

  const publicUrl = savedPath && origin ? `${origin}${savedPath}` : "";

  return (
    <div className="scheduling-form">
      <form className="form-stack scheduling-section" onSubmit={saveEvent}>
        <div className="form-grid">
          <Input name="event-name" label="Event name" maxLength={80} value={currentEvent.name} onChange={(change) => setCurrentEvent({ ...currentEvent, name: change.target.value })} required />
          <Input name="event-slug" label="Event URL ending" hint={mode === "secondary" ? "The URL ending stays fixed after creation." : "Lowercase letters, numbers, and hyphens."} error={slugError} readOnly={mode === "secondary"} maxLength={64} value={currentEvent.slug} onChange={(change) => { setCurrentEvent({ ...currentEvent, slug: change.target.value }); setSlugError(""); }} required />
          <div className="field">
            <label htmlFor="event-duration">Duration</label>
            <select id="event-duration" className="input" value={durationChoice} onChange={(change) => setDurationChoice(change.target.value)}>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">60 minutes</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {durationChoice === "custom" && <Input name="custom-duration" label="Custom minutes" type="number" min={5} max={480} step={1} value={customDuration} onChange={(change) => setCustomDuration(change.target.value)} required />}
        </div>
        <div className="field">
          <label htmlFor="event-description">Description</label>
          <textarea id="event-description" className="textarea" rows={4} maxLength={2000} value={currentEvent.description ?? ""} onChange={(change) => setCurrentEvent({ ...currentEvent, description: change.target.value })} />
        </div>
        <div className="form-grid">
          <Input name="event-location" label="Location" maxLength={500} value={currentEvent.location ?? ""} onChange={(change) => setCurrentEvent({ ...currentEvent, location: change.target.value })} />
          {mode === "default" && <Input name="username" label="Public username" hint="Changes affect all booking page URLs." maxLength={64} value={currentUsername ?? ""} onChange={(change) => setCurrentUsername(change.target.value)} />}
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={currentEvent.active} onChange={(change) => setCurrentEvent({ ...currentEvent, active: change.target.checked })} />
          <span>Active and ready to share</span>
        </label>
        {mode !== "new" && <div className="url-row">
          <div>
            <span className="field-label">Public booking URL</span>
            <code>{savedPath || "Choose a username to create your URL"}</code>
          </div>
          <CopyButton value={publicUrl} disabled={!publicUrl} />
        </div>}
        {eventError && <ErrorField>{eventError}</ErrorField>}
        {eventSaved && <p className="success-message" role="status">Your event type is up to date.</p>}
        <Button type="submit" disabled={eventPending}>{eventPending ? "Saving…" : mode === "new" ? "Create booking page" : "Save event type"}</Button>
      </form>

      {mode === "default" && <section className="question-editor">
        <div className="section-heading">
          <h2>Booking questions</h2>
          <p>Name and email are always asked.</p>
        </div>
        {questionError && <ErrorField>{questionError}</ErrorField>}
        {questionSaved && <p className="success-message" role="status">{questionSaved}</p>}
        <div className="question-list">
          {currentQuestions.length === 0 ? (
            <EmptyState title="No custom questions" description="Add a question if you need more details before a booking." />
          ) : (
            currentQuestions.map((question, index) => (
              <div className="question-item" key={question.id}>
                <div className="question-tools">
                  <Button type="button" variant="secondary" onClick={() => moveQuestion(index, -1)} disabled={questionPending || index === 0} aria-label={`Move ${question.label || "question"} up`}>{questionPendingAction === "reorder" && questionPendingId === question.id ? "Moving…" : "Up"}</Button>
                  <Button type="button" variant="secondary" onClick={() => moveQuestion(index, 1)} disabled={questionPending || index === currentQuestions.length - 1} aria-label={`Move ${question.label || "question"} down`}>{questionPendingAction === "reorder" && questionPendingId === question.id ? "Moving…" : "Down"}</Button>
                </div>
                <Input id={`question-${question.id}-label`} name={`question-${question.id}-label`} label="Question" maxLength={160} value={question.label} onChange={(change) => setCurrentQuestions((current) => current.map((item) => (item.id === question.id ? { ...item, label: change.target.value } : item)))} />
                <div className="field">
                  <label htmlFor={`question-${question.id}-type`}>Answer type</label>
                  <select id={`question-${question.id}-type`} className="input" value={question.questionType} onChange={(change) => setCurrentQuestions((current) => current.map((item) => (item.id === question.id ? { ...item, questionType: change.target.value as QuestionRecord["questionType"], options: change.target.value === "single_choice" ? item.options ?? [] : null } : item)))}>
                    <option value="short_text">Short text</option>
                    <option value="long_text">Long text</option>
                    <option value="single_choice">Single choice</option>
                  </select>
                </div>
                {question.questionType === "single_choice" && (
                  <div className="field">
                    <label htmlFor={`question-${question.id}-options`}>Options</label>
                    <textarea id={`question-${question.id}-options`} className="textarea" rows={4} value={(question.options ?? []).join("\n")} onChange={(change) => setCurrentQuestions((current) => current.map((item) => (item.id === question.id ? { ...item, options: change.target.value.split("\n") } : item)))} />
                    <span className="field-hint">Put each option on its own line.</span>
                  </div>
                )}
                <label className="checkbox-field">
                  <input type="checkbox" checked={question.required} onChange={(change) => setCurrentQuestions((current) => current.map((item) => (item.id === question.id ? { ...item, required: change.target.checked } : item)))} />
                  <span>Required answer</span>
                </label>
                <div className="question-actions">
                  <Button type="button" variant="secondary" onClick={() => updateQuestion(question)} disabled={questionPending}>{questionPendingAction === "save" && questionPendingId === question.id ? "Saving…" : "Save question"}</Button>
                  <Button type="button" variant="secondary" onClick={() => deleteQuestion(question.id)} disabled={questionPending}>{questionPendingAction === "delete" && questionPendingId === question.id ? "Deleting…" : "Delete"}</Button>
                </div>
              </div>
            ))
          )}
        </div>
        <form className="form-stack question-add" onSubmit={addQuestion}>
          <Input name="new-question-label" label="New question" maxLength={160} value={draft.label} onChange={(change) => setDraft({ ...draft, label: change.target.value })} required />
          <div className="field">
            <label htmlFor="new-question-type">Answer type</label>
            <select id="new-question-type" className="input" value={draft.questionType} onChange={(change) => setDraft({ ...draft, questionType: change.target.value as QuestionRecord["questionType"] })}>
              <option value="short_text">Short text</option>
              <option value="long_text">Long text</option>
              <option value="single_choice">Single choice</option>
            </select>
          </div>
          {draft.questionType === "single_choice" && (
            <div className="field">
              <label htmlFor="new-question-options">Options</label>
              <textarea id="new-question-options" className="textarea" rows={4} value={draft.optionsText} onChange={(change) => setDraft({ ...draft, optionsText: change.target.value })} />
              <span className="field-hint">Put each option on its own line.</span>
            </div>
          )}
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.required} onChange={(change) => setDraft({ ...draft, required: change.target.checked })} />
            <span>Required answer</span>
          </label>
          <Button type="submit" disabled={questionPending}>{questionPendingAction === "add" ? "Adding…" : "Add question"}</Button>
        </form>
      </section>}
    </div>
  );
}
