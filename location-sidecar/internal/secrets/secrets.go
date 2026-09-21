package secrets

import (
	"encoding/json"
	"fmt"
	"os"
)

// LoadFromEnvBackend reads SECRETS_BACKEND=file and merges JSON into the
// process environment (without overwriting keys already set).
// For AWS Secrets Manager, inject env via ECS/K8s before process start.
func LoadFromEnvBackend() error {
	backend := os.Getenv("SECRETS_BACKEND")
	if backend == "" || backend == "env" || backend == "aws" {
		return nil
	}
	if backend != "file" {
		return fmt.Errorf("unsupported SECRETS_BACKEND=%q (use env|aws|file)", backend)
	}

	path := os.Getenv("SECRETS_FILE")
	if path == "" {
		path = "secrets.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("SECRETS_FILE: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("SECRETS_FILE JSON: %w", err)
	}
	for k, v := range m {
		if k == "" || v == nil {
			continue
		}
		if cur := os.Getenv(k); cur != "" {
			continue
		}
		switch t := v.(type) {
		case string:
			_ = os.Setenv(k, t)
		default:
			_ = os.Setenv(k, fmt.Sprint(t))
		}
	}
	return nil
}
