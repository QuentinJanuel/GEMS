// §10: a game's blocking dialog, shown with a plain <dialog> element.

import { DIALOG_DISMISSED, type DialogRequest, type DialogResult } from "./spec.ts";

export function showDialog(request: DialogRequest): Promise<DialogResult> {
  const dialog = document.createElement("dialog");
  const text = document.createElement("p");
  text.innerText = request.text;
  dialog.append(text);

  const form = document.createElement("form");
  form.method = "dialog";
  const field = request.input ? document.createElement("input") : null;
  if (field && request.input) {
    field.value = request.input.initial;
    if (request.input.kind === "integer") field.pattern = "[+\\-]?[0-9]+";
    form.append(field);
  }
  let primary: HTMLButtonElement | null = null;
  for (const button of request.buttons) {
    const element = document.createElement("button");
    element.textContent = button.label;
    element.value = String(button.value);
    if (button.kind === "primary") primary = element;
    element.autofocus = button.kind === "primary" && !field;
    form.append(element);
  }
  // Enter in the field means the primary button (§10), not the first one a form would pick.
  field?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && primary) {
      event.preventDefault();
      primary.click();
    }
  });
  dialog.append(form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let button = DIALOG_DISMISSED;
    form.addEventListener("submit", (event) => {
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      button = submitter ? Number(submitter.value) : DIALOG_DISMISSED;
    });
    // Escape closes a <dialog> on its own; only a dismissible request may be closed that way.
    dialog.addEventListener("cancel", (event) => {
      if (!request.dismissible) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve({ button, value: field ? field.value : null });
    });
    dialog.showModal();
  });
}
