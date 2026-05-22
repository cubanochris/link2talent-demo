# GitHub Setup Instructions

Follow these steps to deploy the demo to GitHub Pages.

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Fill in:
   - **Repository name:** `link2talent-demo`
   - **Description:** AI Receptionist Demo - Link2Talent
   - **Visibility:** Public
3. Click **Create repository**

## Step 2: Download & Prepare Files

All files are already prepared in this folder. You just need to push them to GitHub.

## Step 3: Push to GitHub (Windows)

### Option A: Using Git Bash (Recommended)

1. **Install Git** if you haven't: https://git-scm.com/download/win
2. **Open Git Bash** in this folder (right-click → Git Bash Here)
3. Run these commands:

```bash
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"

git init
git add .
git commit -m "Initial commit: AI Receptionist demo"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/link2talent-demo.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

### Option B: Using GitHub Desktop (Easier)

1. Download: https://desktop.github.com/
2. Open it and sign in to your GitHub account
3. Click **File** → **Clone Repository**
4. Select your new `link2talent-demo` repo
5. Copy this folder's contents into the cloned folder
6. In GitHub Desktop:
   - Add a commit message: "Initial commit: AI Receptionist demo"
   - Click **Commit to main**
   - Click **Publish branch**

## Step 4: Enable GitHub Pages

1. Go to your repo: `https://github.com/YOUR_USERNAME/link2talent-demo`
2. Click **Settings** (top right)
3. Left sidebar → **Pages**
4. Under "Source", select **Deploy from a branch**
5. Select **main** branch
6. Click **Save**
7. Wait 1-2 minutes for deployment
8. You'll see: **"Your site is live at https://YOUR_USERNAME.github.io/link2talent-demo/"**

## Step 5: Configure Retell Domain

1. Go to **Retell dashboard** → https://app.retell.ai
2. **Settings** → **API Keys**
3. Find your chat public key: `public_key_90bafc35a99fe27fc4ad3`
4. Add to **Allowed Origins:**
   ```
   https://your-username.github.io
   your-username.github.io
   ```
5. Click **Save**

## Step 6: Test Your Live Demo

Open your live demo:
```
https://your-username.github.io/link2talent-demo/AI%20Receptionist%20Demo.html
```

The widget should now work! Try chatting or making a voice call.

## Troubleshooting

**Widget still says "Public key not allowed"?**
- Check that you updated the Retell allowed origins
- Wait a few minutes for Retell to propagate the change
- Hard refresh your browser (Ctrl+Shift+R)

**Files not showing up?**
- Make sure GitHub Pages deployment completed (check Settings → Pages)
- Try accessing just the demo file path

**Still need help?**
- Contact: descend182@hotmail.com
