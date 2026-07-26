export class UltraWorkNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UltraWorkNotFoundError";
	}
}

export class InvalidUltraWorkStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidUltraWorkStoreError";
	}
}

export class UnsupportedUltraWorkStoreVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedUltraWorkStoreVersionError";
	}
}
