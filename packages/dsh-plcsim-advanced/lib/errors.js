/** Transport-level failures surfaced to the tools as thrown errors. */
export class ControllerFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ControllerFailure';
        this.code = code;
    }
}
