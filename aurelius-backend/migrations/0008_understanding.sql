-- Understanding questions after each video, the patient's closing
-- acknowledgment, and questions patients send their doctor.

-- Multiple-choice questions written by our surgical consultants, loaded
-- with `npm run questions`. A replaced question is retired, never deleted,
-- so earlier answers still point at the wording the patient saw.
CREATE TABLE video_questions (
  id TEXT PRIMARY KEY,                  -- uuid
  video_id TEXT NOT NULL REFERENCES videos(id),
  position INTEGER NOT NULL,            -- 1, 2, 3 ... within the video
  prompt TEXT NOT NULL,
  choices TEXT NOT NULL,                -- JSON array of 2 to 5 strings
  correct_index INTEGER NOT NULL,       -- 0-based index into choices
  explanation TEXT,                     -- shown after a wrong answer
  created_at TEXT NOT NULL,
  retired_at TEXT                       -- NULL while in use
);
CREATE INDEX video_questions_active ON video_questions(video_id, retired_at, position);

-- Every answer a patient gives, right or wrong.
CREATE TABLE question_answers (
  id TEXT PRIMARY KEY,                  -- uuid
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  question_id TEXT NOT NULL REFERENCES video_questions(id),
  chosen_index INTEGER NOT NULL,
  correct INTEGER NOT NULL,             -- 1 or 0
  answered_at TEXT NOT NULL
);
CREATE INDEX question_answers_prescription ON question_answers(prescription_id, video_id);

-- A video counts as done (and unlocks the next) once it is watched in full
-- AND its questions are all answered correctly. Videos without questions
-- are understood the moment they are watched.
ALTER TABLE video_progress ADD COLUMN understood_at TEXT;
UPDATE video_progress SET understood_at = completed_at WHERE completed_at IS NOT NULL;

-- The patient's closing statement that they understand, required before
-- the certificate is issued.
ALTER TABLE prescriptions ADD COLUMN acknowledged_at TEXT;
-- Prescriptions already certified were complete under the earlier rules.
UPDATE prescriptions SET acknowledged_at = (SELECT issued_at FROM certificates c WHERE c.prescription_id = prescriptions.id)
  WHERE EXISTS (SELECT 1 FROM certificates c WHERE c.prescription_id = prescriptions.id);

-- "I have a question for my doctor", sent from the acknowledgment step.
CREATE TABLE patient_questions (
  id TEXT PRIMARY KEY,                  -- uuid
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  question TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doctor_notified_at TEXT,
  answered_at TEXT                      -- the doctor marked it answered
);
CREATE INDEX patient_questions_prescription ON patient_questions(prescription_id);
