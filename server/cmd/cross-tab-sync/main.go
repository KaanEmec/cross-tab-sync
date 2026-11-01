// Command cross-tab-sync runs the Cross-Tab-Sync service. Sessions and
// invites are created from the extension; there are no admin commands.
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

Configuration (environment):
  CTS_ADDR                listen address (default :8080)
  CTS_DB_PATH             SQLite database path (default ./data/cts.db)
  CTS_ALLOW_INSECURE      accept plain HTTP without X-Forwarded-Proto: https (default false)
  CTS_OWNER_LIVENESS      owner liveness window (default 10m)
  CTS_SNAPSHOT_RETENTION  recovery snapshots kept (default 20)
  CTS_HISTORY_RETENTION   operation and tombstone history kept (default 720h)
  CTS_SESSION_RETENTION   sessions without device activity this long are deleted (default 4320h)
  CTS_MAX_SESSIONS        sessions on this server, 0 = unlimited (default 0; a personal server sets 1)
  CTS_MAX_DEVICES         active devices per session (default 10)
  CTS_CLIENT_IP_HEADER    header carrying the client IP for the rate limit, e.g. CF-Connecting-IP
                          (default: the last X-Forwarded-For entry, else the connection address)
  CTS_DEBUG               accept client diagnostics on POST /v3/diag (development only)
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

	// Session and history pruning: once now, then hourly until shutdown. Deferred after
	// st.Close so the pruner has stopped before the database closes.
	pruneCtx, stopPruner := context.WithCancel(ctx)
	pruned := make(chan struct{})
	go func() {
		defer close(pruned)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		st.RunPruner(pruneCtx, ticker.C, cfg.HistoryRetention, cfg.SessionRetention, time.Now, logger)
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
