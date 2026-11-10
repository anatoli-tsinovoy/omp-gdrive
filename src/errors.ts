export class DriveNotConnectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DriveNotConnectedError";
	}
}

export class DriveAuthError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DriveAuthError";
	}
}
