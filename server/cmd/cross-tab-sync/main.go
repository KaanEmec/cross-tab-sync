// Command cross-tab-sync runs the Cross-Tab-Sync service and its admin tasks.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/api"
	"github.com/kaanemec/cross-tab-sync/server/internal/config"
	"github.com/kaanemec/cross-tab-sync/server/internal/store"
)

const usage = `Usage: cross-tab-sync <command>

Commands:
  serve       run the HTTP service
  pair-code   create a single-use pairing code (valid 10 minutes); prints the
              pairing link (CTS_PUBLIC_URL#CODE) when CTS_PUBLIC_URL is set.
              For the first browser only: further browsers are invited from a
              paired browser's popup, whose link carries the encryption key

Configuration (environment):
  CTS_ADDR                listen address (default :8080)
  CTS_DB_PATH             SQLite database path (default ./data/cts.db)
  CTS_ALLOW_INSECURE      accept plain HTTP without X-Forwarded-Proto: https (default false)
  CTS_OWNER_LIVENESS      owner liveness window (default 10m)
  CTS_SNAPSHOT_RETENTION  recovery snapshots kept (default 20)
  CTS_HISTORY_RETENTION   operation and tombstone history kept (default 720h)
  CTS_PUBLIC_URL          public base URL of the service, e.g. https://tabs.example.com
                          (default: derived from each request; the CLI prints bare codes)
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintf(stderr, "configuration: %v\n", err)
		return 2
	}
	switch args[0] {
	case "serve":
		logger := slog.New(slog.NewJSONHandler(stdout, nil))
		if err := serve(cfg, logger); err != nil {
			logger.Error("server stopped", slog.String("error", err.Error()))
			return 1
		}
		return 0
	case "pair-code":
		if err := pairCode(cfg, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "pair-code: %v\n", err)
			return 1
		}
		return 0
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprint(stderr, usage)
		return 2
	}
}

func serve(cfg config.Config, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	// History pruning: once now, then hourly until shutdown. Deferred after
	// st.Close so the pruner has stopped before the database closes.
	pruneCtx, stopPruner := context.WithCancel(ctx)
	pruned := make(chan struct{})
	go func() {
		defer close(pruned)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		st.RunPruner(pruneCtx, ticker.C, cfg.HistoryRetention, time.Now, logger)
	}()
	defer func() {
		stopPruner()
		<-pruned
	}()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(st, cfg, logger, nil),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	logger.Info("listening", slog.String("addr", cfg.Addr), slog.Bool("allow_insecure", cfg.AllowInsecure))

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func pairCode(cfg config.Config, stdout, stderr io.Writer) error {
	ctx := context.Background()
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()
	code, expires, err := st.CreatePairingCode(ctx, "", time.Now())
	if err != nil {
		return err
	}
	if cfg.PublicURL != "" {
		fmt.Fprintln(stdout, api.PairingLink(cfg.PublicURL, code))
	} else {
		fmt.Fprintln(stdout, code)
		fmt.Fprintln(stderr, "set CTS_PUBLIC_URL (e.g. https://tabs.example.com) to print a pairing link to paste instead")
	}
	fmt.Fprintf(stderr, "single use, valid until %s\n", expires.Local().Format(time.DateTime))
	fmt.Fprintln(stderr, "Use this link for the first browser only; invite further browsers from a paired browser's popup (its link carries the encryption key).")
	return nil
}
