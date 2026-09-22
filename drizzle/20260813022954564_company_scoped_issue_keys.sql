ALTER TABLE suplex_companies ADD COLUMN issue_code TEXT;
--> statement-breakpoint
ALTER TABLE suplex_companies ADD COLUMN next_issue_number INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE suplex_tasks ADD COLUMN issue_number INTEGER;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS issue_number
  FROM suplex_tasks
)
UPDATE suplex_tasks
SET issue_number = (SELECT ranked.issue_number FROM ranked WHERE ranked.id = suplex_tasks.id);
--> statement-breakpoint
UPDATE suplex_companies
SET next_issue_number = COALESCE((
  SELECT max(suplex_tasks.issue_number) + 1
  FROM suplex_tasks
  WHERE suplex_tasks.company_id = suplex_companies.id
), 1);
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_tasks_company_issue_number_unique
ON suplex_tasks(company_id, issue_number)
WHERE issue_number IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER suplex_tasks_assign_issue_number
AFTER INSERT ON suplex_tasks
WHEN NEW.issue_number IS NULL
BEGIN
  UPDATE suplex_tasks
  SET issue_number = (
    SELECT next_issue_number
    FROM suplex_companies
    WHERE id = NEW.company_id
  )
  WHERE id = NEW.id;

  UPDATE suplex_companies
  SET next_issue_number = next_issue_number + 1
  WHERE id = NEW.company_id;
END;
