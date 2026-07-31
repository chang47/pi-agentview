// Left-Arrow editor: on an EMPTY buffer, Left Arrow submits /agents through
// Pi's real editor submission callback (runs normal slash-command dispatch,
// so the command handler gets the session-switching APIs). If the buffer has
// text, the key is passed through so Left Arrow still moves the cursor.

import { CustomEditor } from "@earendil-works/pi-coding-agent";

const AGENTS_COMMAND = "/agents";
const LEFT_ARROW = "\x1b[D";
const LEFT_ARROW_APP = "\x1bOD"; // application cursor mode

export class AgentsEditor extends CustomEditor {
  handleInput(data: string): void {
    if ((data === LEFT_ARROW || data === LEFT_ARROW_APP) && this.getText().length === 0) {
      this.onSubmit?.(AGENTS_COMMAND);
      return;
    }
    super.handleInput(data);
  }
}
