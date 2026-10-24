/** Transport-level failures surfaced to the tools as thrown errors. */
export class ControllerFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ControllerFailure'
    this.code = code
  }
}
