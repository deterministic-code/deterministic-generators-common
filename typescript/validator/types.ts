export interface Position {
  line: number;
  col: number;
}

export interface SpecValidationError {
  line: number;
  col: number;
  instancePath: string;
  message: string;
}

export interface SpecValidationResult {
  valid: boolean;
  errors: SpecValidationError[];
}

export interface ValidateOptions {
  /** Companion `types.yaml` text. Required for non-empty seeds. */
  types?: string;
  /** Path to companion `types.yaml`. Ignored when `types` is set. */
  typesPath?: string;
  /** Companion `datasource.yaml` text. Required for non-empty seeds. */
  datasource?: string;
  /** Path to companion `datasource.yaml`. Ignored when `datasource` is set. */
  datasourcePath?: string;
  /** Absolute path of the document being validated. Set by `validateFile`. */
  includeFilePath?: string;
  /** Directory used to resolve `file:` includes. Set by `validateFile`. */
  includeBasePath?: string;
}

export interface AjvError {
  keyword: string;
  instancePath: string;
  message?: string;
  params?: Record<string, unknown>;
}

export interface ValidateFn {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}

export interface AjvLike {
  compile(schema: unknown): ValidateFn;
}
