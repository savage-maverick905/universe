pkg update
pkg install git
git --version
termux-setup-storage
ls ~/storage/shared/Download
pkg install unzip
unzip ~/storage/shared/Download/universe-github-storage.zip
git init
git add .
git config --global user.name "savage-maverick"
git config --global user.email "hietechnologiesinc@gmail.com"
git commit -m "Initial commit"
git remote add origin https://github.com/savage-maverick905/universe
git branch -M main
git push -u origin main
git remote -v
git config --global --unset credential.helper
git push -u origin main
git pull origin main --allow-unrelated-histories
git push -u origin main
git push -u origin main --force
cd ~
git clone https://github.com/savage-maverick905/universe.git
cd universe
ls -la
git remote -v
git status
git ls-tree --name-only HEAD
cd ~/storage/downloads
ls
rm -rf ~/universe-update
mkdir ~/universe-update
unzip "universe-v2-mobile.zip" -d ~/universe-update
ls ~/universe-update
cp -r ~/universe ~/universe-backup
cp -rf ~/universe-update/universe/. ~/universe/
cd ~/universe
git status
git add .
git commit -m "Update Universe v2 mobile"
git push
pkg update && pkg upgrade
pkg install nmap dig whois openssh python -y
# Who owns a domain?
whois google.com
# Where does it point?
dig google.com
# Look at the raw request
curl -I https://google.com
cd ~
git clone https://github.com/savage-maverick905/universe
git rm -rf .
unzip ~/storage/downloads/universe-code.zip -d .
unzip ~/storage/downloads/universe-code.zip -d .ls ~/storage/downloads
cd ls ~/storage
cd ~/storage/downloads
unzip universe-code.zip -d ~/REPO
pkg update
pkg install git unzip
termux-setup-storage
unzip ~/storage/downloads/universe-code.zip -d .
git add -A
git commit -m "Universe for Vercel"
git push
