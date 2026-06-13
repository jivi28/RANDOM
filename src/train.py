"""Train the solar-farm land-suitability classifier (PU / proxy labels).

RandomForest on the 64-dim AlphaEarth embedding (+ available Tier-2 numeric
features). Evaluated on a *spatial* hold-out so neighbouring patches can't leak
between train and test. Saves the model + feature list with joblib.

Run:
    python -m src.train
"""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (average_precision_score, classification_report,
                             confusion_matrix, roc_auc_score)
from sklearn.model_selection import GroupShuffleSplit

from . import config

# Tier-2 numeric features to include when present (landcover stays categorical
# and is used only for masking in predict.py, not as a model feature).
TIER2_NUMERIC = ["slope", "ghi", "cloud", "dist_powerline_m"]


def feature_columns(df: pd.DataFrame) -> list[str]:
    cols = [b for b in config.EMBEDDING_BANDS if b in df.columns]
    for c in TIER2_NUMERIC:
        if c in df.columns and df[c].notna().any():
            cols.append(c)
    return cols


def _spatial_blocks(df: pd.DataFrame) -> np.ndarray:
    """Assign each point to a SPATIAL_SPLIT_KM block id (for grouped split)."""
    block_deg_lat = config.SPATIAL_SPLIT_KM / 111.0
    block_deg_lon = config.SPATIAL_SPLIT_KM / 70.0  # ~111*cos(49N)
    bx = (df["lon"] / block_deg_lon).astype(int)
    by = (df["lat"] / block_deg_lat).astype(int)
    return (bx.astype(str) + "_" + by.astype(str)).values


def train(df: pd.DataFrame | None = None):
    if df is None:
        df = pd.read_csv(config.F_LABEL_FEATURES)

    feats = feature_columns(df)
    df = df.dropna(subset=feats).reset_index(drop=True)
    X = df[feats].values
    y = df["label"].astype(int).values
    groups = _spatial_blocks(df)

    splitter = GroupShuffleSplit(n_splits=1, test_size=0.25,
                                 random_state=config.RANDOM_SEED)
    train_idx, test_idx = next(splitter.split(X, y, groups))

    clf = RandomForestClassifier(**config.RF_PARAMS)
    clf.fit(X[train_idx], y[train_idx])

    proba = clf.predict_proba(X[test_idx])[:, 1]
    pred = (proba >= 0.5).astype(int)
    y_test = y[test_idx]

    print("\n=== Spatial hold-out evaluation ===")
    print(f"train n={len(train_idx)}  test n={len(test_idx)}  "
          f"(blocks: {len(set(groups))})")
    print(f"ROC-AUC : {roc_auc_score(y_test, proba):.3f}")
    print(f"PR-AUC  : {average_precision_score(y_test, proba):.3f}")
    print("Confusion matrix [rows=true 0/1, cols=pred 0/1]:")
    print(confusion_matrix(y_test, pred))
    print(classification_report(y_test, pred, digits=3))

    imp = sorted(zip(feats, clf.feature_importances_), key=lambda t: -t[1])
    print("Top 10 features:")
    for name, val in imp[:10]:
        print(f"  {name:18s} {val:.4f}")

    # Refit on all data for the deployed model.
    final = RandomForestClassifier(**config.RF_PARAMS).fit(X, y)
    joblib.dump({"model": final, "features": feats}, config.F_MODEL)
    print(f"\n[train] saved model -> {config.F_MODEL.name} ({len(feats)} features)")
    return final, feats


if __name__ == "__main__":
    train()
